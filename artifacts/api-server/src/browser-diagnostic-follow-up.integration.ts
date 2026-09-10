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
  const databaseName = `teras_follow_up_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let appServer: Express | undefined;
  let server: ReturnType<Express["listen"]> | undefined;
  let database: pg.Client | undefined;
  let applicationPool: pg.Pool | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
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
    await database.query(
      `INSERT INTO teras_diagnostic_sessions
        (id, learner_id, enrollment_id, pathway_id, template_id, framework_id, status, progress, completed_at, created_by)
       VALUES ('browser-follow-up-session', 'learner-demo', 'enrol-demo', 'path-a', 'diag-skttk-spv-v1', 'framework-skttk-solar-pv', 'completed', 100, now(), 'learner-demo')`,
    );
    await database.query(
      `INSERT INTO teras_diagnostic_profiles
        (id, session_id, learner_id, pathway_id, framework_id, framework_version, current_state, dimension_summaries, created_by)
       VALUES ('browser-follow-up-profile', 'browser-follow-up-session', 'learner-demo', 'path-a', 'framework-skttk-solar-pv', '1.0', 'SUPERVISED_PRACTICE', '{"Safety": 55}'::jsonb, 'learner-demo')`,
    );
    await database.query(
      `INSERT INTO teras_diagnostic_recommendations
        (id, profile_id, competency_unit_id, framework_id, unit_code, unit_title, kind, title, rationale, priority, created_by)
       VALUES ('browser-follow-up-recommendation', 'browser-follow-up-profile', 'skttk-u-safe-isolation', 'framework-skttk-solar-pv', 'SKTTK-SPV-01', 'Keselamatan dan isolasi listrik', 'practice', 'Supervised isolation practice', 'Close the observed safety practice gap.', 'HIGH', 'learner-demo')`,
    );

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
    if (!address || typeof address === "string") throw new Error("Could not determine browser follow-up test server address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
    const { page } = await BrowserTestIdentityHarness.createPage(browser, "integration-trainer");
    page.on("console", message => {
      if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on("pageerror", error => process.stderr.write(`[browser pageerror] ${error.message}\n`));

    await page.goto(`${baseUrl}/trainer`);
    const card = page.getByText("Supervised isolation practice", { exact: true }).locator("..").locator("..");
    await page.getByTestId("trainer-diagnostic-follow-ups").waitFor();
    await page.getByText("Supervised isolation practice", { exact: true }).waitFor();

    const submittedDrafts: Array<{ idempotencyKey?: string; note?: string }> = [];
    let disconnectFirstResponse = true;
    await page.route("**/api/trainer/diagnostic-recommendations/*/follow-ups", async route => {
      submittedDrafts.push(route.request().postDataJSON());
      if (disconnectFirstResponse) {
        disconnectFirstResponse = false;
        await route.fetch();
        await route.abort("connectionaborted");
        return;
      }
      await route.continue();
    });

    await page.getByLabel("Follow-up status for Supervised isolation practice").click();
    await page.getByRole("option", { name: "Planned", exact: true }).click();
    await page.getByLabel("Target date for Supervised isolation practice").fill("2026-10-15");
    await page.getByLabel("Follow-up note for Supervised isolation practice").fill("Schedule supervised isolation practice");
    await card.getByRole("button", { name: "Record follow-up" }).click();
    await page.getByText("Follow-up failed", { exact: true }).waitFor();
    if (await page.getByLabel("Follow-up status for Supervised isolation practice").textContent() !== "Planned") {
      throw new Error("The follow-up status was not preserved after the failed request.");
    }
    if (await page.getByLabel("Target date for Supervised isolation practice").inputValue() !== "2026-10-15") {
      throw new Error("The follow-up target date was not preserved after the failed request.");
    }
    if (await page.getByLabel("Follow-up note for Supervised isolation practice").inputValue() !== "Schedule supervised isolation practice") {
      throw new Error("The follow-up note was not preserved after the failed request.");
    }
    await card.getByRole("button", { name: "Record follow-up" }).click();
    await page.getByText("Follow-up recorded", { exact: true }).waitFor();
    await card.getByText("Planned", { exact: true }).first().waitFor();
    await card.getByText(/Target .*10\/15\/2026|Target .*15\/10\/2026/).waitFor();
    await page.getByText("Schedule supervised isolation practice", { exact: true }).waitFor();
    if (
      !submittedDrafts[0]?.idempotencyKey
      || submittedDrafts[0].idempotencyKey !== submittedDrafts[1]?.idempotencyKey
    ) {
      throw new Error("Retrying the unchanged follow-up draft did not preserve its idempotency key.");
    }

    await page.getByLabel("Follow-up status for Supervised isolation practice").click();
    await page.getByRole("option", { name: "In progress", exact: true }).click();
    await page.getByLabel("Target date for Supervised isolation practice").fill("2026-10-20");
    await page.getByLabel("Follow-up note for Supervised isolation practice").fill("Trainer and learner started the supervised practice");
    await card.getByRole("button", { name: "Record follow-up" }).click();
    await page.getByText("Trainer and learner started the supervised practice", { exact: true }).waitFor();
    if (
      !submittedDrafts[2]?.idempotencyKey
      || submittedDrafts[2].idempotencyKey === submittedDrafts[1]?.idempotencyKey
    ) {
      throw new Error("Changing the follow-up draft did not create a new idempotency key.");
    }

    await page.reload();
    await page.getByText("Supervised isolation practice", { exact: true }).waitFor();
    await page.getByText("In progress", { exact: true }).first().waitFor();
    await page.getByText("Trainer and learner started the supervised practice", { exact: true }).waitFor();
    if (await page.getByLabel("Target date for Supervised isolation practice").inputValue() !== "2026-10-20") {
      throw new Error("The latest target date was not restored after refreshing the trainer card.");
    }
    await page.getByText("View 2 recorded changes", { exact: true }).click();
    await page.getByText("Schedule supervised isolation practice", { exact: true }).waitFor();
    await page.getByText("Trainer and learner started the supervised practice", { exact: true }).waitFor();

    const stored = await database.query<{ status: string; note: string }>(
      "SELECT status, note FROM teras_diagnostic_recommendation_follow_ups WHERE recommendation_id = 'browser-follow-up-recommendation' ORDER BY created_at, id",
    );
    if (stored.rows.length !== 2 || stored.rows[0]?.status !== "planned" || stored.rows[1]?.status !== "in_progress") {
      throw new Error("The disconnected response retry duplicated a follow-up or lost the changed draft.");
    }
    process.stdout.write("browser diagnostic follow-up integration passed\n");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await database?.end();
    await applicationPool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});