import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
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

async function count(client: pg.Client, table: "teras_practice_attempts" | "teras_evidence") {
  return Number((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE learner_id = 'learner-demo'`)).rows[0]?.count);
}

async function countWhere(client: pg.Client, table: string, column: string, value: string) {
  return Number((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`, [value])).rows[0]?.count);
}

async function setState(client: pg.Client, activityId: string, state: string) {
  await client.query(
    `INSERT INTO teras_learning_transition_events
      (id, activity_id, learner_id, enrollment_id, program_id, pathway_id, from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key, metadata, created_by)
     VALUES ($1, $2, 'learner-demo', 'enrol-demo', 'solar-pv-tech', 'path-a', 'TEST_SETUP', $3, 'learner-demo', 'learner', 'task-41', 'Isolated browser harness setup', $4, '{}'::jsonb, 'task-41')`,
    [`task-41-state-${crypto.randomUUID()}`, activityId, state, `task-41-state-${crypto.randomUUID()}`],
  );
}

function requestPath(request: express.Request) {
  return new URL(request.originalUrl, "http://browser-harness.test").pathname;
}

async function main() {
  const adminUrl = requiredTestDatabaseUrl();
  const databaseName = `teras_task41_${crypto.randomUUID().replaceAll("-", "")}`;
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
    // The forms submit through the real learner routes.  These state rows only
    // prepare the isolated learner for the same gated workflow a browser sees.
    await setState(database, "activity-m03-safe-isolation", "PRACTICE_REQUIRED");
    await database.query(`
      INSERT INTO teras_practice_attempts
        (id, task_id, learner_id, pathway_id, reflection, output_summary, status, created_by)
      VALUES
        ('browser-review-practice', 'task-m03', 'learner-demo', 'path-a', 'Review fixture reflection', 'Review fixture output', 'Submitted', 'learner-demo');
      INSERT INTO teras_learning_record_links
        (id, learner_id, pathway_id, activity_id, practice_attempt_id, relation, metadata, created_by)
      VALUES
        ('browser-review-practice-link', 'learner-demo', 'path-a', 'activity-m03-safe-isolation', 'browser-review-practice', 'produced', '{}'::jsonb, 'learner-demo');
      INSERT INTO teras_evidence
        (id, learner_id, pathway_id, module_id, task_id, title, type, description, created_by)
      VALUES
        ('browser-review-evidence', 'learner-demo', 'path-a', 'm03', 'task-m03', 'Browser retry evidence', 'Checklist', 'Evidence fixture for a disconnected trainer review.', 'learner-demo');
      INSERT INTO teras_gaps
        (id, learner_id, pathway_id, module_id, capability, criterion, severity, priority, diagnosis, gate, recommended_action, created_by)
      VALUES
        ('browser-review-gap', 'learner-demo', 'path-a', 'm03', 'Safe isolation', 'SAFE-01', 'Critical', 'High', 'Browser retry fixture', 'G1', 'Repeat under supervision', 'learner-demo');
      INSERT INTO teras_remediation_plans
        (id, gap_id, title, description, due_label, created_by)
      VALUES
        ('browser-review-plan', 'browser-review-gap', 'Browser retry remediation', 'Retry fixture remediation plan.', 'This week', 'learner-demo');
      INSERT INTO teras_remediation_activities
        (id, plan_id, title, description, type, created_by)
      VALUES
        ('browser-review-activity', 'browser-review-plan', 'Repeat safe isolation', 'Retry fixture remediation activity.', 'Coaching', 'learner-demo');
    `);

    const requests: Array<{ path: string; key: string }> = [];
    const heldResponses = new Set(["/api/practice/tasks/task-m03/attempts", "/api/evidence"]);
    const droppedReviewResponses = new Set([
      "/api/trainer/practice/browser-review-practice/review",
      "/api/trainer/evidence/browser-review-evidence/review",
    ]);
    const commitWaiters = new Map<string, () => void>();
    const waitForCommit = (requestPath: string) => new Promise<void>((resolve) => {
      commitWaiters.set(requestPath, resolve);
    });
    // Database modules read DATABASE_URL at import time.  This assignment occurs
    // only after the disposable database exists and before the test app imports.
    process.env.DATABASE_URL = databaseUrl.toString();
    ({ pool: applicationPool } = await import("@workspace/db"));
    const { createIntegrationTestApp } = await import("./integration-test-app");
    let authorizationIdentity: { userId: string; role: "learner" | "trainer"; learnerId?: string } = {
      userId: "task-41-browser",
      role: "learner",
      learnerId: "learner-demo",
    };
    appServer = createIntegrationTestApp(
      () => authorizationIdentity,
      {
        afterCommit: (request) => {
          if (request.method === "POST" && typeof request.body?.idempotencyKey === "string") {
            const path = requestPath(request);
            requests.push({ path, key: request.body.idempotencyKey });
            commitWaiters.get(path)?.();
            commitWaiters.delete(path);
          }
        },
        holdResponseAfterCommit: (request) => {
          const path = requestPath(request);
          return request.method === "POST" && heldResponses.delete(path);
        },
        dropResponseAfterCommit: (request) => {
          const path = requestPath(request);
          return request.method === "POST" && droppedReviewResponses.delete(path);
        },
      },
    );
    const frontend = path.join(root, "artifacts/teras-academy/dist/public");
    appServer.use(express.static(frontend));
    appServer.get(/.*/, (_req, res) => res.sendFile(path.join(frontend, "index.html")));
    server = appServer.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine test server address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumExecutablePath(),
    });
    const { page, identity } = await BrowserTestIdentityHarness.createPage(
      browser,
      "task-41-browser",
    );
    page.on("console", message => {
      if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on("pageerror", error => process.stderr.write(`[browser pageerror] ${error.message}\n`));
    page.on("requestfailed", request => process.stderr.write(`[browser requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}\n`));
    const practiceUrl = `${baseUrl}/practice?taskId=task-m03&activityId=activity-m03-safe-isolation`;
    await page.goto(practiceUrl);
    await page.locator("textarea").nth(0).fill("First isolated output");
    await page.locator("textarea").nth(1).fill("First isolated reflection");
    const firstPracticeCommit = waitForCommit("/api/practice/tasks/task-m03/attempts");
    await page.getByRole("button", { name: "COMMIT ATTEMPT RECORD" }).click();
    await firstPracticeCommit;
    await page.reload();
    await page.locator("textarea").nth(0).fill("First isolated output");
    await page.locator("textarea").nth(1).fill("First isolated reflection");
    await page.getByRole("button", { name: "COMMIT ATTEMPT RECORD" }).click();
    const evidenceHref = await page.getByRole("link", { name: "CONTINUE TO EVIDENCE" }).getAttribute("href");
    if (!evidenceHref) throw new Error("The real practice form did not return its evidence link.");
    if (await count(database, "teras_practice_attempts") !== 1) throw new Error("Retrying the identical practice draft did not leave exactly one practice record.");
    const practiceKeys = requests.filter(item => item.path.includes("/practice/")).map(item => item.key);
    if (practiceKeys.length < 2 || practiceKeys[0] !== practiceKeys[1]) throw new Error("Reload and retry did not reuse the practice idempotency key.");

    // A remediation state permits another real practice submission on the same
    // flow, so changing the draft (not the route) must allocate a fresh key.
    await setState(database, "activity-m03-safe-isolation", "REMEDIATION");
    await page.goto(practiceUrl);
    await page.locator("textarea").nth(0).fill("Changed isolated output");
    await page.locator("textarea").nth(1).fill("First isolated reflection");
    await page.getByRole("button", { name: "COMMIT ATTEMPT RECORD" }).click();
    await page.getByRole("link", { name: "CONTINUE TO EVIDENCE" }).waitFor();
    if (await count(database, "teras_practice_attempts") !== 2) throw new Error("Changing the practice draft did not create a second record.");
    if (new Set(requests.filter(item => item.path.includes("/practice/")).map(item => item.key)).size !== 2) throw new Error("Changing the practice draft did not allocate a new idempotency key.");

    const evidenceUrl = new URL(evidenceHref, baseUrl).toString();
    await page.goto(evidenceUrl);
    await page.locator("input").fill("First isolated evidence");
    await page.locator("textarea").fill("Evidence created after the isolated practice attempt.");
    const firstEvidenceCommit = waitForCommit("/api/evidence");
    await page.getByRole("button", { name: "SUBMIT FOR REVIEW" }).click();
    await firstEvidenceCommit;
    await page.reload();
    await page.locator("input").fill("First isolated evidence");
    await page.locator("textarea").fill("Evidence created after the isolated practice attempt.");
    await page.getByRole("button", { name: "SUBMIT FOR REVIEW" }).click();
    await page.getByText("Evidence submitted", { exact: true }).waitFor();
    if (await count(database, "teras_evidence") !== 3) throw new Error("Retrying the identical evidence draft did not leave exactly one new evidence record.");
    const evidenceKeys = requests.filter(item => item.path === "/api/evidence").map(item => item.key);
    if (evidenceKeys.length < 2 || evidenceKeys[0] !== evidenceKeys[1]) throw new Error("Reload and retry did not reuse the evidence idempotency key.");

    // Leave real practice and evidence drafts in localStorage while their
    // committed responses are held, then cross the signed-out identity gate.
    await setState(database, "activity-m03-safe-isolation", "REMEDIATION");
    heldResponses.add("/api/practice/tasks/task-m03/attempts");
    await page.goto(practiceUrl);
    await page.locator("textarea").nth(0).fill("Account boundary output");
    await page.locator("textarea").nth(1).fill("Account boundary reflection");
    const boundaryPracticeCommit = waitForCommit("/api/practice/tasks/task-m03/attempts");
    await page.getByRole("button", { name: "COMMIT ATTEMPT RECORD" }).click();
    await boundaryPracticeCommit;
    const previousPracticeKey = requests.filter(item => item.path.includes("/practice/")).at(-1)?.key;

    heldResponses.add("/api/evidence");
    await page.goto(evidenceUrl);
    await page.locator("input").fill("Account boundary evidence");
    await page.locator("textarea").fill("Evidence draft held across an account boundary.");
    const boundaryEvidenceCommit = waitForCommit("/api/evidence");
    await page.getByRole("button", { name: "SUBMIT FOR REVIEW" }).click();
    await boundaryEvidenceCommit;
    const previousEvidenceKey = requests.filter(item => item.path === "/api/evidence").at(-1)?.key;

    await identity.signOut();
    await page.getByRole("link", { name: "Masuk", exact: true }).first().waitFor();
    await identity.signIn("task-41-browser-next-account");

    await setState(database, "activity-m03-safe-isolation", "REMEDIATION");
    await page.goto(practiceUrl);
    await page.locator("textarea").nth(0).fill("Account boundary output");
    await page.locator("textarea").nth(1).fill("Account boundary reflection");
    await page.getByRole("button", { name: "COMMIT ATTEMPT RECORD" }).click();
    await page.getByRole("link", { name: "CONTINUE TO EVIDENCE" }).waitFor();
    const nextPracticeKey = requests.filter(item => item.path.includes("/practice/")).at(-1)?.key;
    if (!previousPracticeKey || !nextPracticeKey || previousPracticeKey === nextPracticeKey) {
      throw new Error("The next account reused the previous account's practice idempotency key.");
    }

    await page.goto(evidenceUrl);
    await page.locator("input").fill("Account boundary evidence");
    await page.locator("textarea").fill("Evidence draft held across an account boundary.");
    await page.getByRole("button", { name: "SUBMIT FOR REVIEW" }).click();
    await page.getByText("Evidence submitted", { exact: true }).waitFor();
    const nextEvidenceKey = requests.filter(item => item.path === "/api/evidence").at(-1)?.key;
    if (!previousEvidenceKey || !nextEvidenceKey || previousEvidenceKey === nextEvidenceKey) {
      throw new Error("The next account reused the previous account's evidence idempotency key.");
    }

    authorizationIdentity = { userId: "trainer-aria", role: "trainer" };
    await identity.signIn("trainer-aria");
    await page.goto(`${baseUrl}/trainer`);
    const reviewDrafts: Array<{ path: string; key: string }> = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.includes("/api/trainer/")) {
        const body = request.postDataJSON() as { idempotencyKey?: string };
        if (body.idempotencyKey) reviewDrafts.push({ path, key: body.idempotencyKey });
      }
    });

    const review = async (id: string, comment: string) => {
      await page.getByTestId(`button-review-${id}`).click();
      await page.getByTestId("select-trainer-review-outcome").click();
      await page.getByRole("option", { name: "Needs revision", exact: true }).click();
      await page.getByTestId("input-trainer-review-comment").fill(comment);
      await page.getByTestId("button-record-trainer-review").click();
    };
    const retryAfterReload = async (id: string, comment: string) => {
      await page.reload();
      await review(id, comment);
      await page.getByText("Review recorded", { exact: true }).waitFor();
    };
    const assertSameRetryKey = (path: string) => {
      const keys = reviewDrafts.filter(item => item.path === path).map(item => item.key);
      if (keys.length !== 2 || keys[0] !== keys[1]) {
        throw new Error(`Reload and retry did not reuse the trainer review idempotency key for ${path}.`);
      }
    };

    const gapEventsBefore = await countWhere(database, "teras_gap_events", "gap_id", "browser-review-gap");
    const remediationEventsBefore = await countWhere(database, "teras_remediation_events", "activity_id", "browser-review-activity");

    const practiceReviewPath = "/api/trainer/practice/browser-review-practice/review";
    await review("browser-review-practice", "Repeat the isolation sequence");
    await page.getByText("Review failed", { exact: true }).waitFor();
    await retryAfterReload("browser-review-practice", "Repeat the isolation sequence");
    assertSameRetryKey(practiceReviewPath);
    if (await countWhere(database, "teras_practice_reviews", "attempt_id", "browser-review-practice") !== 1) {
      throw new Error("The disconnected practice review retry duplicated review history.");
    }
    if (await countWhere(database, "teras_gap_events", "gap_id", "browser-review-gap") !== gapEventsBefore + 1) {
      throw new Error("The disconnected practice review retry duplicated gap history.");
    }
    if (await countWhere(database, "teras_remediation_events", "activity_id", "browser-review-activity") !== remediationEventsBefore + 1) {
      throw new Error("The disconnected practice review retry duplicated remediation history.");
    }
    await review("browser-review-practice", "Repeat the isolation sequence with a supervisor");
    await page.getByText("Review recorded", { exact: true }).waitFor();
    const practiceReviewKeys = reviewDrafts.filter(item => item.path === practiceReviewPath).map(item => item.key);
    if (practiceReviewKeys.length !== 3 || practiceReviewKeys[2] === practiceReviewKeys[1]) {
      throw new Error("Changing the practice review draft did not allocate a new idempotency key.");
    }
    if (await countWhere(database, "teras_practice_reviews", "attempt_id", "browser-review-practice") !== 2) {
      throw new Error("Changing the practice review draft did not append a new review.");
    }
    if (await countWhere(database, "teras_gap_events", "gap_id", "browser-review-gap") !== gapEventsBefore + 2) {
      throw new Error("The changed practice review draft did not append exactly one new gap event.");
    }
    if (await countWhere(database, "teras_remediation_events", "activity_id", "browser-review-activity") !== remediationEventsBefore + 2) {
      throw new Error("The changed practice review draft did not append exactly one new remediation event.");
    }

    const evidenceReviewPath = "/api/trainer/evidence/browser-review-evidence/review";
    const gapEventsBeforeEvidence = await countWhere(database, "teras_gap_events", "gap_id", "browser-review-gap");
    const remediationEventsBeforeEvidence = await countWhere(database, "teras_remediation_events", "activity_id", "browser-review-activity");
    await review("browser-review-evidence", "Add a traceable proving record");
    await page.getByText("Review failed", { exact: true }).waitFor();
    await retryAfterReload("browser-review-evidence", "Add a traceable proving record");
    assertSameRetryKey(evidenceReviewPath);
    if (await countWhere(database, "teras_evidence_reviews", "evidence_id", "browser-review-evidence") !== 1) {
      throw new Error("The disconnected evidence review retry duplicated review history.");
    }
    if (await countWhere(database, "teras_gap_events", "gap_id", "browser-review-gap") !== gapEventsBeforeEvidence + 1) {
      throw new Error("The disconnected evidence review retry duplicated gap history.");
    }
    if (await countWhere(database, "teras_remediation_events", "activity_id", "browser-review-activity") !== remediationEventsBeforeEvidence + 1) {
      throw new Error("The disconnected evidence review retry duplicated remediation history.");
    }
    await review("browser-review-evidence", "Add a signed and traceable proving record");
    await page.getByText("Review recorded", { exact: true }).waitFor();
    const evidenceReviewKeys = reviewDrafts.filter(item => item.path === evidenceReviewPath).map(item => item.key);
    if (evidenceReviewKeys.length !== 3 || evidenceReviewKeys[2] === evidenceReviewKeys[1]) {
      throw new Error("Changing the evidence review draft did not allocate a new idempotency key.");
    }
    if (await countWhere(database, "teras_evidence_reviews", "evidence_id", "browser-review-evidence") !== 2) {
      throw new Error("Changing the evidence review draft did not append a new review.");
    }
    if (await countWhere(database, "teras_gap_events", "gap_id", "browser-review-gap") !== gapEventsBeforeEvidence + 2) {
      throw new Error("The changed evidence review draft did not append exactly one new gap event.");
    }
    if (await countWhere(database, "teras_remediation_events", "activity_id", "browser-review-activity") !== remediationEventsBeforeEvidence + 2) {
      throw new Error("The changed evidence review draft did not append exactly one new remediation event.");
    }
    process.stdout.write("browser idempotency integration passed\n");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await database?.end();
    await applicationPool?.end();
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
    await admin.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});