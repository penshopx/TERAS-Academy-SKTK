import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import { chromium, type Locator, type Page } from "playwright";
import { BrowserTestIdentityHarness } from "./browser-test-identity-harness.js";

// Inventory of data-changing confirmation gates:
// trainer: full-day reminder pause (browser-reminder-preferences.integration.ts),
// course archive, draft entity archive, immutable course publish;
// admin: user deactivation and program/pathway/cohort/enrollment status changes,
// plus the audited resolution of a permanently failed reminder.
// Creation/edit/review forms are not confirmation gates.
const root = path.resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);
const chromiumPath = "/repl/tools/bin/chromium";
const courseId = "keyboard-course";
const moduleId = "keyboard-module";
const now = "2026-01-01T00:00:00.000Z";
const course = {
  id: courseId, programId: "program-1", pathwayId: "pathway-1", title: "Keyboard course",
  description: "Browser fixture", status: "DRAFT", sequence: 1,
  modules: [{ id: moduleId, moduleId: "module-1", moduleCode: "M1", moduleName: "Keyboard module", sequence: 1, lessons: [] }],
};
const reminder = {
  id: "keyboard-reminder", trainerId: "trainer-1", trainerName: "Keyboard trainer",
  target: "Follow up", targetAt: now, lastAttemptAt: now, reason: "Delivery failed",
  emailNotification: null, webhookNotification: null, status: "open", resolution: null,
};
const summary = {
  generatedAt: now, metrics: [],
  bottleneck: { stage: "clear", label: "Clear", description: "No alerts", count: 0 },
  incompleteAssignments: { trainer: 0, assessor: 0 }, queues: [], actions: [],
  failedTrainerReminders: [reminder], reminderEscalationCounts: { open: 1, resolved: 0, total: 1 },
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function keyboardGate(
  page: Page,
  trigger: Locator,
  dialog: Locator,
  confirm: Locator,
  mutationCount: () => number,
  label: string,
  prepare?: () => Promise<void>,
) {
  const before = mutationCount();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  assert(await dialog.evaluate(node => node.contains(node.ownerDocument.activeElement)), `${label}: initial focus escaped dialog`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(mutationCount() === before, `${label}: Escape sent a mutation`);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "visible" });
  await prepare?.();
  // Check both edges of the focus loop, not merely one Tab in the middle.
  const focusable = dialog.locator('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
  const first = focusable.first();
  const last = focusable.last();
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  assert(await dialog.evaluate(node => node.contains(node.ownerDocument.activeElement)), `${label}: Shift+Tab left dialog`);
  await last.focus();
  await page.keyboard.press("Tab");
  assert(await dialog.evaluate(node => node.contains(node.ownerDocument.activeElement)), `${label}: Tab left dialog`);
  await confirm.focus();
  const submitted = page.waitForResponse(response => response.request().method() !== "GET" && new URL(response.url()).pathname.startsWith("/api/"));
  await page.keyboard.press("Enter");
  await submitted;
  assert(mutationCount() === before + 1, `${label}: keyboard confirmation did not send exactly one mutation`);
}

async function main() {
  await execFileAsync("pnpm", ["--filter", "@workspace/teras-academy", "exec", "vite", "build", "--config", "vite.config.ts", "--mode", "test"], {
    cwd: root, env: { ...process.env, NODE_ENV: "test", BASE_PATH: "/", PORT: "4173", VITE_INTEGRATION_TEST_MODE: "true" },
  });
  let role: "trainer" | "admin" = "trainer";
  const mutations: Array<{ path: string; body: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method)) {
      mutations.push({ path: request.path, body: request.body });
      if (request.path.endsWith("/resolution")) {
        response.json({ id: "resolution-1", reminderDeliveryId: reminder.id, note: "Handled by phone", resolvedByPersonId: "admin-1", resolvedAt: now });
      } else if (request.path.endsWith("/publish")) {
        response.json({ id: "version-1", courseId, version: 1, authoringRevision: 1, lifecycle: "PUBLISHED", publishedAt: now });
      } else if (request.path.endsWith("/commands")) {
        response.json({ id: moduleId, entity: "COURSE_MODULE", action: "ARCHIVE", status: "ARCHIVED" });
      } else {
        response.json({ id: "program-1", name: "Keyboard program", domain: "Energy", description: "Fixture", status: "archived" });
      }
      return;
    }
    next();
  });
  app.get("/api/session", (_request, response) => response.json({ id: `keyboard-${role}`, userId: `keyboard-${role}`, roles: [role], name: "Keyboard fixture" }));
  app.get("/api/trainer/dashboard", (_request, response) => response.json({
    trainer: { id: "trainer-1", name: "Keyboard trainer", initials: "KT", role: "trainer", organization: "TERAS" },
    assignedLearnerCount: 0, pendingFeedbackCount: 0, pendingEvidenceCount: 0,
    activeRemediationCount: 0, blockedLearnerCount: 0, recentActivity: [], reviewHistory: [], diagnosticFollowUps: [],
    bottlenecks: { asOf: now, assignedContextCount: 0, counts: {}, mostStalled: null },
  }));
  app.get("/api/trainer/reminder-preferences", (_request, response) => response.json({
    emailEnabled: true, timeZone: "Asia/Jakarta", quietHoursStart: null, quietHoursEnd: null,
  }));
  app.get("/api/trainer/reminder-preferences/history", (_request, response) => response.json([]));
  app.get("/api/trainer/authoring/courses", (_request, response) => response.json([course]));
  app.get("/api/trainer/authoring/baselines", (_request, response) => response.json([]));
  app.get(`/api/trainer/authoring/courses/${courseId}/preview`, (_request, response) => response.json({ course, validation: { courseId, valid: true, errors: [], warnings: [] } }));
  app.get(`/api/trainer/authoring/courses/${courseId}/validation`, (_request, response) => response.json({ courseId, valid: true, errors: [], warnings: [] }));
  app.get("/api/trainer/authoring/courses/:id/versions", (_request, response) => response.json([]));
  app.get("/api/trainer/authoring/courses/:id/audit", (_request, response) => response.json([]));
  app.get("/api/admin/access", (_request, response) => response.json({ authorized: true }));
  app.get("/api/admin/summary", (_request, response) => response.json(summary));
  app.get("/api/admin/reminder-escalations", (_request, response) => response.json({
    items: [reminder], pagination: { limit: 25, offset: 0, returned: 1, total: 1, hasMore: false },
    counts: { open: 1, resolved: 0, total: 1 },
  }));
  app.get("/api/admin/agent-observability", (_request, response) => response.json({
    totals: { runCount: 0, completedCount: 0, partialCount: 0, failedCount: 0, fallbackRate: 0, p95TerminalLatencyMs: null },
  }));
  app.get("/api/admin/module-catalogue", (_request, response) => response.json({ canonicalModules: [], legacyModules: [] }));
  app.get("/api/admin/programs", (_request, response) => response.json([{
    id: "program-1", name: "Keyboard program", domain: "Energy", description: "Fixture", status: "active",
  }]));
  app.get("/api/admin/*path", (_request, response) => response.json([]));
  const frontend = path.join(root, "artifacts/teras-academy/dist/public");
  app.use(express.static(frontend));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(frontend, "index.html")));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "Browser confirmation fixture did not bind");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(chromiumPath) ? chromiumPath : undefined) });
  try {
    const { page } = await BrowserTestIdentityHarness.createPage(browser, "keyboard-trainer");
    page.on("pageerror", error => process.stderr.write(`[browser pageerror] ${error.message}\n`));
    page.on("console", message => { if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`); });
    const mutationCount = () => mutations.length;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await page.goto(`${baseUrl}/trainer`);
    await page.waitForLoadState("networkidle");
    assert(await page.getByRole("tab", { name: "Course Authoring" }).count(), `Trainer workspace unavailable: ${(await page.locator("body").innerText()).slice(0, 800)}`);
    await page.getByRole("tab", { name: "Course Authoring" }).click();
    await page.getByTestId("select-course").click();
    await page.getByTestId(`item-course-${courseId}`).click();
    await page.getByTestId("button-course-actions").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("button-archive-course").focus();
    await page.keyboard.press("Enter");
    // Dropdown items open the confirmation directly; use its original action as trigger on reopen.
    const archiveCourse = page.getByRole("alertdialog", { name: "Are you absolutely sure?" });
    await archiveCourse.waitFor();
    await page.keyboard.press("Escape");
    await archiveCourse.waitFor({ state: "hidden" });
    assert(mutationCount() === 0, "Course archive Escape sent a mutation");
    await page.getByTestId("button-course-actions").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("button-archive-course").focus();
    await page.keyboard.press("Enter");
    await archiveCourse.waitFor();
    assert(await archiveCourse.evaluate(node => node.contains(node.ownerDocument.activeElement)), "Course archive initial focus escaped");
    await archiveCourse.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Shift+Tab");
    assert(await archiveCourse.evaluate(node => node.contains(node.ownerDocument.activeElement)), "Course archive Shift+Tab escaped");
    await archiveCourse.getByTestId("button-confirm-archive-course").focus();
    await page.keyboard.press("Tab");
    assert(await archiveCourse.evaluate(node => node.contains(node.ownerDocument.activeElement)), "Course archive Tab escaped");
    await archiveCourse.getByTestId("button-confirm-archive-course").focus();
    const courseSubmitted = page.waitForResponse(response => response.url().endsWith("/api/trainer/authoring/commands") && response.request().method() === "POST");
    await page.keyboard.press("Enter");
    await courseSubmitted;
    assert(mutationCount() === 1 && (mutations[0]?.body as { entity?: string })?.entity === "COURSE", "Course archive confirmation sent wrong mutation");

    // Reselect the unchanged fixture course to expose the draft tree.
    await page.getByTestId("select-course").click();
    await page.getByTestId(`item-course-${courseId}`).click();
    await keyboardGate(page, page.getByTestId(`button-archive-${moduleId}`), page.getByRole("alertdialog", { name: "Archive Entity?" }),
      page.getByTestId("button-confirm-archive-entity"), mutationCount, "Draft entity archive");
    assert((mutations.at(-1)?.body as { entity?: string })?.entity === "COURSE_MODULE", "Draft entity archive targeted wrong entity");
    await keyboardGate(page, page.getByTestId("button-publish-course"), page.getByRole("dialog", { name: "Confirm Publish" }),
      page.getByTestId("button-confirm-publish"), mutationCount, "Course publication");
    assert(mutations.at(-1)?.path.endsWith("/publish"), "Course publish confirmation targeted wrong endpoint");

    role = "admin";
    const { page: adminPage } = await BrowserTestIdentityHarness.createPage(browser, "keyboard-admin");
    adminPage.on("console", message => { if (message.type() === "error") process.stderr.write(`[admin console] ${message.text()}\n`); });
    await adminPage.goto(`${baseUrl}/admin`);
    await adminPage.waitForLoadState("networkidle");
    assert(await adminPage.getByTestId("button-admin-tab-programs").count(), `Admin workspace unavailable: ${(await adminPage.locator("body").innerText()).slice(0, 800)}`);
    await keyboardGate(adminPage, adminPage.getByTestId(`button-resolve-reminder-${reminder.id}`),
      adminPage.getByRole("dialog", { name: "Tandai eskalasi sudah ditangani" }),
      adminPage.getByTestId("button-submit-reminder-resolution"), mutationCount, "Reminder escalation resolution",
      async () => {
        await adminPage.getByTestId("input-reminder-resolution-note").focus();
        await adminPage.keyboard.type("Handled by phone");
      });
    assert(mutations.at(-1)?.path === `/api/admin/reminder-escalations/${reminder.id}/resolution`, "Resolution targeted wrong reminder");
    await adminPage.getByTestId("button-admin-tab-programs").click();
    await keyboardGate(adminPage, adminPage.getByTestId("button-archive-program-1"),
      adminPage.getByRole("alertdialog", { name: "Konfirmasi perubahan status" }),
      adminPage.getByTestId("button-confirm-admin-status"), mutationCount, "Admin status change");
    assert(mutations.at(-1)?.path === "/api/admin/programs/program-1", "Admin status confirmation targeted wrong program");
    process.stdout.write("Operational confirmation keyboard gates passed.\n");
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });