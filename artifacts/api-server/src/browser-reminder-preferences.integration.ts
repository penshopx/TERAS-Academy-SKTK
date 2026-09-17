import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import pg from "pg";
import { chromium } from "playwright";
import type { Express } from "express";
import { requiredTestDatabaseUrl } from "./browser-idempotency-guard.js";
import { BrowserTestIdentityHarness } from "./browser-test-identity-harness.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const { Client } = pg;
const replitChromiumPath = "/repl/tools/bin/chromium";

function chromiumExecutablePath() {
  const configuredPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configuredPath) return configuredPath;
  return existsSync(replitChromiumPath) ? replitChromiumPath : undefined;
}

async function run(command: string, args: string[], databaseUrl: string, extraEnvironment: NodeJS.ProcessEnv = {}) {
  await execFileAsync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment, NODE_ENV: "test", DATABASE_URL: databaseUrl },
  });
}

async function main() {
  const adminUrl = requiredTestDatabaseUrl();
  const databaseName = `teras_reminder_browser_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let appServer: Express | undefined;
  let server: ReturnType<Express["listen"]> | undefined;
  let database: pg.Client | undefined;
  let applicationPool: pg.Pool | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let databaseCreated = false;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    await run("pnpm", ["--filter", "@workspace/db", "exec", "drizzle-kit", "push", "--force", "--config", "./drizzle.config.ts"], databaseUrl.toString());
    await run("pnpm", ["--filter", "@workspace/scripts", "run", "seed:demo"], databaseUrl.toString(), {
      TERAS_ENABLE_DEMO_FIXTURES: "1",
    });
    await run("pnpm", ["--filter", "@workspace/teras-academy", "exec", "vite", "build", "--config", "vite.config.ts", "--mode", "test"], databaseUrl.toString(), {
      BASE_PATH: "/",
      PORT: "4173",
      VITE_INTEGRATION_TEST_MODE: "true",
    });

    database = new Client({ connectionString: databaseUrl.toString() });
    await database.connect();
    await database.query("UPDATE teras_people SET clerk_user_id = 'integration-trainer' WHERE id = 'trainer-aria'");

    process.env.DATABASE_URL = databaseUrl.toString();
    ({ pool: applicationPool } = await import("@workspace/db"));
    const { createIntegrationTestApp } = await import("./integration-test-app");
    appServer = createIntegrationTestApp(() => ({ userId: "integration-trainer", role: "trainer" }));
    const frontend = path.join(root, "artifacts/teras-academy/dist/public");
    appServer.use(express.static(frontend));
    appServer.get(/.*/, (_request, response) => response.sendFile(path.join(frontend, "index.html")));
    server = appServer.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine reminder browser test server address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
    const { page } = await BrowserTestIdentityHarness.createPage(browser, "integration-trainer");
    page.on("console", message => {
      if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on("pageerror", error => process.stderr.write(`[browser pageerror] ${error.message}\n`));

    const submitted: Array<{
      confirmFullDayQuietHours?: boolean;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
    }> = [];
    let failNextPreferenceUpdate = true;
    await page.route("**/api/trainer/reminder-preferences", async route => {
      if (route.request().method() === "PUT") {
        submitted.push(route.request().postDataJSON());
        if (failNextPreferenceUpdate) {
          failNextPreferenceUpdate = false;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Reminder preferences are temporarily unavailable." }),
          });
          return;
        }
      }
      await route.continue();
    });

    await page.goto(`${baseUrl}/trainer`);
    await page.getByTestId("trainer-reminder-preferences").waitFor();
    const quietHours = page.getByRole("switch", { name: "Use quiet hours" });
    if ((await quietHours.getAttribute("data-state")) !== "checked") await quietHours.click();
    await page.getByLabel("Quiet hours start").fill("20:00");
    await page.getByLabel("Quiet hours end").fill("20:00");
    await page.getByTestId("full-day-quiet-hours-warning").waitFor();

    const savePreferences = page.getByRole("button", { name: "Save reminder preferences" });
    const fullDayDialog = page.getByRole("alertdialog");
    const cancelFullDayPause = page.getByRole("button", { name: "Go back" });
    const confirmFullDayPause = page.getByTestId("confirm-full-day-quiet-hours");

    await savePreferences.focus();
    await page.keyboard.press("Enter");
    await fullDayDialog.getByText("Pause reminders for the full 24 hours?", { exact: true }).waitFor();
    if (!await fullDayDialog.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement))) {
      throw new Error("Opening the full-day confirmation did not move focus into the dialog.");
    }
    await page.keyboard.press("Escape");
    await fullDayDialog.waitFor({ state: "hidden" });
    await savePreferences.waitFor();
    if (!await savePreferences.evaluate(button => button === button.ownerDocument.activeElement)) {
      throw new Error("Cancelling the full-day confirmation did not restore focus to the save button.");
    }
    if (submitted.length !== 0) throw new Error("Cancelling the full-day confirmation with Escape submitted a preference change.");

    await page.keyboard.press("Enter");
    await fullDayDialog.waitFor();
    await cancelFullDayPause.focus();
    await page.keyboard.press("Shift+Tab");
    if (!await fullDayDialog.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement))) {
      throw new Error("Shift+Tab allowed focus to leave the full-day confirmation dialog.");
    }
    await confirmFullDayPause.focus();
    await page.keyboard.press("Tab");
    if (!await fullDayDialog.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement))) {
      throw new Error("Tab allowed focus to leave the full-day confirmation dialog.");
    }
    await confirmFullDayPause.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Preferences not saved", { exact: true }).waitFor();
    const deliveryStatus = page.getByTestId("trainer-reminder-delivery-status");
    await deliveryStatus.getByText("Delivery active", { exact: true }).waitFor();
    if ((await deliveryStatus.textContent())?.includes("Delivery paused")) {
      throw new Error("A failed full-day pause changed the visible delivery status.");
    }
    if (
      await page.getByLabel("Quiet hours start").inputValue() !== "20:00"
      || await page.getByLabel("Quiet hours end").inputValue() !== "20:00"
    ) {
      throw new Error("A failed full-day pause discarded the trainer's entered times.");
    }

    await savePreferences.focus();
    await page.keyboard.press("Enter");
    await confirmFullDayPause.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Reminder preferences saved", { exact: true }).waitFor();
    const failedFullDaySubmission = submitted.at(0);
    const fullDaySubmission = submitted.at(1);
    if (
      !failedFullDaySubmission
      || !fullDaySubmission
      || submitted.at(2) !== undefined
      || failedFullDaySubmission.confirmFullDayQuietHours !== true
      || failedFullDaySubmission.quietHoursStart !== "20:00"
      || failedFullDaySubmission.quietHoursEnd !== "20:00"
      || fullDaySubmission.confirmFullDayQuietHours !== true
      || fullDaySubmission.quietHoursStart !== "20:00"
      || fullDaySubmission.quietHoursEnd !== "20:00"
    ) {
      throw new Error(`Full-day quiet hours used an unexpected mutation payload: ${JSON.stringify(submitted)}`);
    }
    await deliveryStatus.getByText("Delivery paused", { exact: true }).waitFor();
    await deliveryStatus.getByText("Quiet hours are active.", { exact: true }).waitFor();
    if ((await deliveryStatus.textContent())?.includes("Delivery resumes")) {
      throw new Error("A full-day pause displayed a next delivery time.");
    }

    await page.getByLabel("Quiet hours end").fill("21:00");
    await page.getByRole("button", { name: "Save reminder preferences" }).click();
    await page.getByText("Reminder preferences saved", { exact: true }).waitFor();
    if (await page.getByRole("alertdialog").isVisible()) {
      throw new Error("A normal quiet-hours interval opened the full-day confirmation dialog.");
    }
    const normalSubmission = submitted.at(2);
    if (
      !normalSubmission
      || submitted.at(3) !== undefined
      || normalSubmission.confirmFullDayQuietHours !== false
      || normalSubmission.quietHoursStart !== "20:00"
      || normalSubmission.quietHoursEnd !== "21:00"
    ) {
      throw new Error(`Normal quiet hours used an unexpected mutation payload: ${JSON.stringify(submitted)}`);
    }

    process.stdout.write("browser reminder preferences integration passed\n");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await database?.end();
    await applicationPool?.end();
    if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});