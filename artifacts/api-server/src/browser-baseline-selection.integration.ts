import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import { chromium } from "playwright";
import { BrowserTestIdentityHarness } from "./browser-test-identity-harness.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const replitChromiumPath = "/repl/tools/bin/chromium";

function chromiumExecutablePath() {
  const configuredPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configuredPath) return configuredPath;
  return existsSync(replitChromiumPath) ? replitChromiumPath : undefined;
}

async function run(command: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  await execFileAsync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment, NODE_ENV: "test" },
  });
}

async function main() {
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await run("pnpm", ["--filter", "@workspace/teras-academy", "exec", "vite", "build", "--config", "vite.config.ts", "--mode", "test"], {
      BASE_PATH: "/",
      PORT: "4173",
      VITE_INTEGRATION_TEST_MODE: "true",
    });

    const appServer = express();
    appServer.get("/api/session", (_request, response) => response.json({
      personId: "integration-trainer",
      name: "Integration Trainer",
      roles: ["trainer"],
    }));
    appServer.get("/api/trainer/dashboard", (_request, response) => response.json({
      trainer: {
        id: "integration-trainer",
        name: "Integration Trainer",
        initials: "IT",
        role: "trainer",
        organization: "TERAS integration",
      },
      assignedLearnerCount: 1,
      pendingFeedbackCount: 0,
      pendingEvidenceCount: 0,
      activeRemediationCount: 0,
      blockedLearnerCount: 0,
      diagnosticFollowUps: [],
      recentActivity: [],
      reviewHistory: [],
      bottlenecks: {
        asOf: new Date(0).toISOString(),
        assignedContextCount: 1,
        counts: {},
        mostStalled: null,
      },
    }));
    appServer.get("/api/*path", (_request, response) => response.json([]));
    const frontend = path.join(root, "artifacts/teras-academy/dist/public");
    appServer.use(express.static(frontend));
    appServer.get(/.*/, (_request, response) => response.sendFile(path.join(frontend, "index.html")));
    server = appServer.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not determine baseline browser test server address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutablePath() });
    const { page } = await BrowserTestIdentityHarness.createPage(browser, "integration-trainer");
    page.on("console", message => {
      if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`);
    });
    page.on("pageerror", error => process.stderr.write(`[browser pageerror] ${error.message}\n`));

    const baselineId = "assigned-baseline";
    const firstDraftId = "assigned-draft-v8";
    const selectedDraftId = "assigned-draft-v9";
    const outOfScopeBaselineId = "outside-assignment-baseline";
    const requestedPaths: string[] = [];
    const now = new Date(0).toISOString();
    const versions = [
      { id: "assigned-active-v7", baselineId, version: 7, status: "PUBLISHED", snapshot: {}, createdBy: "fixture", createdAt: now, publishedBy: "fixture", publishedAt: now, cancelledBy: null, cancelledAt: null },
      { id: firstDraftId, baselineId, version: 8, status: "DRAFT", snapshot: {}, createdBy: "fixture", createdAt: now, publishedBy: null, publishedAt: null, cancelledBy: null, cancelledAt: null },
      { id: selectedDraftId, baselineId, version: 9, status: "DRAFT", snapshot: {}, createdBy: "fixture", createdAt: now, publishedBy: null, publishedAt: null, cancelledBy: null, cancelledAt: null },
    ];

    await page.route("**/api/trainer/authoring/baselines**", async route => {
      const url = new URL(route.request().url());
      requestedPaths.push(url.pathname);
      const previewMatch = url.pathname.match(/^\/api\/trainer\/authoring\/baselines\/([^/]+)\/versions\/([^/]+)\/publication-preview$/);
      if (url.pathname === "/api/trainer/authoring/baselines") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{
            baselineId,
            code: "ASSIGNED",
            name: "Baseline Penugasan Aktif",
            activeVersion: 7,
            draftCount: 2,
          }]),
        });
        return;
      }
      if (url.pathname === `/api/trainer/authoring/baselines/${baselineId}/versions`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(versions) });
        return;
      }
      if (url.pathname === `/api/trainer/authoring/baselines/${baselineId}/audit`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (previewMatch?.[1] === baselineId && previewMatch[2] === selectedDraftId) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            baselineId,
            activeVersion: { id: "assigned-active-v7", version: 7 },
            draftVersion: { id: selectedDraftId, version: 9 },
            baselineChanged: true,
            baselineBefore: { description: "Active baseline description" },
            baselineAfter: { description: "Selected draft v9 description" },
            changes: [],
            impact: {
              affectedPathways: [],
              eligibleCohorts: [],
              preservedEnrollmentCount: 0,
              historyRule: "Existing enrollment history remains pinned.",
            },
            previewFingerprint: "a".repeat(64),
          }),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: `Unexpected or out-of-scope baseline request: ${url.pathname}` }),
      });
    });

    await page.goto(`${baseUrl}/trainer`);
    await page.getByRole("tab", { name: "Course Authoring" }).click();
    await page.getByTestId("baseline-publication-gate").waitFor();

    const baselineSelect = page.getByLabel("Pilih baseline");
    const optionLabels = await baselineSelect.locator("option").allTextContents();
    if (!optionLabels.includes("Baseline Penugasan Aktif (ASSIGNED) · Aktif v7 · 2 draft")) {
      throw new Error(`The assigned baseline option did not show its name, active version, and draft count: ${optionLabels.join(" | ")}`);
    }
    if (optionLabels.some(label => label.includes(outOfScopeBaselineId))) {
      throw new Error("A baseline outside the trainer's active assignment was available in the selector.");
    }

    await baselineSelect.selectOption(baselineId);
    const draftSelect = page.getByLabel("Draft yang akan ditinjau");
    await draftSelect.waitFor();
    const draftLabels = await draftSelect.locator("option").allTextContents();
    if (!draftLabels.includes("Versi 8") || !draftLabels.includes("Versi 9")) {
      throw new Error(`Selecting the baseline did not load its draft list: ${draftLabels.join(" | ")}`);
    }

    await draftSelect.selectOption(selectedDraftId);
    const preview = page.getByTestId("baseline-publication-preview");
    await preview.waitFor();
    await preview.getByText("Draft v9", { exact: true }).waitFor();
    await preview.getByText("Selected draft v9 description", { exact: false }).waitFor();
    if (!requestedPaths.includes(`/api/trainer/authoring/baselines/${baselineId}/versions/${selectedDraftId}/publication-preview`)) {
      throw new Error(`The selected draft did not request its matching preview: ${requestedPaths.join(", ")}`);
    }
    if (requestedPaths.some(requestPath => requestPath.includes(firstDraftId) && requestPath.endsWith("/publication-preview"))) {
      throw new Error("Selecting draft v9 loaded the preview for draft v8.");
    }
    if (requestedPaths.some(requestPath => requestPath.includes(outOfScopeBaselineId))) {
      throw new Error("The browser requested data for a baseline outside the trainer's assignment.");
    }

    process.stdout.write("browser baseline selection integration passed\n");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});