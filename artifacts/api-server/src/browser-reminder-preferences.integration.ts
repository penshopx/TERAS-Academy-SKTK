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
    await page.route("**/api/trainer/reminder-preferences", async route => {
      if (route.request().method() === "PUT") submitted.push(route.request().postDataJSON());
      await route.continue();
    });

    await page.goto(`${baseUrl}/trainer`);
    await page.getByTestId("trainer-reminder-preferences").waitFor();
    const quietHours = page.getByRole("switch", { name: "Use quiet hours" });
    if ((await quietHours.getAttribute("data-state")) !== "checked") await quietHours.click();
    await page.getByLabel("Quiet hours start").fill("20:00");
    await page.getByLabel("Quiet hours end").fill("20:00");
    await page.getByTestId("full-day-quiet-hours-warning").waitFor();

    await page.getByRole("button", { name: "Save reminder preferences" }).click();
    await page.getByRole("alertdialog").getByText("Pause reminders for the full 24 hours?", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Go back" }).click();
    if (submitted.length !== 0) throw new Error("Cancelling the full-day confirmation submitted a preference change.");

    await page.getByRole("button", { name: "Save reminder preferences" }).click();
    await page.getByTestId("confirm-full-day-quiet-hours").click();
    await page.getByText("Reminder preferences saved", { exact: true }).waitFor();
    const fullDaySubmission = submitted.at(0);
    if (
      !fullDaySubmission
      || submitted.at(1) !== undefined
      || fullDaySubmission.confirmFullDayQuietHours !== true
      || fullDaySubmission.quietHoursStart !== "20:00"
      || fullDaySubmission.quietHoursEnd !== "20:00"
    ) {
      throw new Error(`Full-day quiet hours used an unexpected mutation payload: ${JSON.stringify(submitted)}`);
    }
    const deliveryStatus = page.getByTestId("trainer-reminder-delivery-status");
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
    const normalSubmission = submitted.at(1);
    if (
      !normalSubmission
      || submitted.at(2) !== undefined
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