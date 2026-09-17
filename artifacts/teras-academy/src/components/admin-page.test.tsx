import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adminErrorMessage, filterQueueItems, getReminderDeliveryRefetchInterval, hasPermanentReminderEscalations, isAdminForbidden, isAdminMfaRequired, queueStateFromSearch, reminderDeliveryPollingInterval, shouldEnableAdminQueries, validateQueueFilters } from "../pages/admin";

test("admin conflict errors provide an actionable accessible message", () => {
  assert.equal(
    adminErrorMessage({ status: 409, data: { error: "duplicate" } }),
    "Konflik: data sudah ada atau berubah. Muat ulang lalu coba lagi.",
  );
});

test("admin errors retain the API message when no conflict exists", () => {
  assert.equal(adminErrorMessage({ data: { error: "Tidak diizinkan" } }), "Tidak diizinkan");
});

test("admin forbidden response has a safe access-denied state", () => {
  assert.equal(isAdminForbidden({ status: 403 }), true);
  assert.equal(adminErrorMessage({ status: 403 }), "Anda tidak memiliki akses admin.");
});

test("admin MFA denial is distinguished from a missing role", () => {
  assert.equal(isAdminMfaRequired({ status: 403, data: { error: "Super administrator MFA (aal2) is required" } }), true);
  assert.equal(isAdminMfaRequired({ status: 403, data: { error: "Administrator role required" } }), false);
});

test("admin detail queries wait for a completed successful access gate", () => {
  assert.equal(shouldEnableAdminQueries({ isSuccess: false, isFetching: true }), false);
  assert.equal(shouldEnableAdminQueries({ isSuccess: true, isFetching: true, data: { authorized: true } }), false);
  assert.equal(shouldEnableAdminQueries({ isSuccess: false, isFetching: false, data: { authorized: true } }), false);
  assert.equal(shouldEnableAdminQueries({ isSuccess: true, isFetching: false, data: { authorized: true } }), true);
});

test("queue filters combine available operational context safely", () => {
  const items = [
    { id: "one", learnerId: "learner-a", pathwayId: "path-a", trainerId: "trainer-a", assessorId: null },
    { id: "two", learnerId: "learner-b", pathwayId: "path-b", trainerId: null, assessorId: "assessor-b" },
  ];
  assert.deepEqual(filterQueueItems(items, { learner: "learner-a", pathway: "path-a", trainer: "trainer-a", assessor: "unassigned" }).map(item => item.id), ["one"]);
  assert.deepEqual(filterQueueItems(items, { learner: "", pathway: "", trainer: "unassigned", assessor: "" }).map(item => item.id), ["two"]);
  assert.deepEqual(filterQueueItems(items, { learner: "unknown", pathway: "", trainer: "", assessor: "" }), []);
});

test("queue links restore the selected detail and filters from the URL", () => {
  const restored = queueStateFromSearch("?queue=remediation&learner=learner-a&trainer=unassigned");
  assert.deepEqual(restored, {
    selectedQueue: "remediation",
    filters: { learner: "learner-a", pathway: "", trainer: "unassigned", assessor: "" },
  });
  assert.deepEqual(validateQueueFilters([
    { learnerId: "learner-a", pathwayId: "path-a", trainerId: null, assessorId: "assessor-a" },
  ], restored.filters), restored.filters);
});

test("switching queues through the URL clears filters unavailable in the active queue", () => {
  const restored = queueStateFromSearch("?queue=assessment&learner=learner-from-remediation&trainer=trainer-a&assessor=unassigned");
  assert.deepEqual(validateQueueFilters([
    { learnerId: "learner-assessment", pathwayId: "path-a", trainerId: "trainer-a", assessorId: "assessor-a" },
  ], restored.filters), {
    learner: "",
    pathway: "",
    trainer: "trainer-a",
    assessor: "",
  });
});

test("stale or missing queue links clear the selected detail safely", () => {
  assert.deepEqual(queueStateFromSearch("?queue=unknown&assessor=assessor-a"), {
    selectedQueue: null,
    filters: { learner: "", pathway: "", trainer: "", assessor: "assessor-a" },
  });
  assert.deepEqual(queueStateFromSearch(""), {
    selectedQueue: null,
    filters: { learner: "", pathway: "", trainer: "", assessor: "" },
  });
});

test("only open permanent trainer reminder failures activate the admin alarm", () => {
  assert.equal(hasPermanentReminderEscalations({ failedTrainerReminders: [] }), false);
  assert.equal(hasPermanentReminderEscalations({ failedTrainerReminders: [{
    id: "delivery-1", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    emailNotification: null, webhookNotification: null, status: "open", resolution: null,
  }] }), true);
  assert.equal(hasPermanentReminderEscalations({ failedTrainerReminders: [{
    id: "delivery-2", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    emailNotification: null, webhookNotification: null, status: "resolved", resolution: { id: "resolution-1", reminderDeliveryId: "delivery-2", note: "Sudah dihubungi", resolvedByPersonId: "admin-1", resolvedAt: "2030-01-09T05:00:00.000Z" },
  }] }), false);
});

test("admin summary polls while a reminder notification delivery is still in progress", () => {
  const reminder = {
    id: "delivery-1", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Pengiriman belum selesai.",
    emailNotification: { status: "sent" as const, attemptedAt: "2030-01-09T03:00:00.000Z", sentAt: "2030-01-09T03:00:01.000Z", reason: null },
    webhookNotification: { status: "pending" as const, attemptedAt: null, sentAt: null, reason: null },
    status: "open" as const, resolution: null,
  };

  assert.equal(getReminderDeliveryRefetchInterval({ failedTrainerReminders: [reminder] }), reminderDeliveryPollingInterval);
  assert.equal(getReminderDeliveryRefetchInterval({
    failedTrainerReminders: [{
      ...reminder,
      webhookNotification: { ...reminder.webhookNotification, status: "sending" as const },
    }],
  }), reminderDeliveryPollingInterval);
});

test("admin summary stops polling after every reminder notification reaches a final status", () => {
  const reminder = {
    id: "delivery-1", trainerId: "trainer-1", trainerName: "Trainer Satu", target: "Inspeksi inverter",
    targetAt: "2030-01-10T00:00:00.000Z", lastAttemptAt: "2030-01-09T03:00:00.000Z", reason: "Pengiriman selesai diproses.",
    emailNotification: { status: "sent" as const, attemptedAt: "2030-01-09T03:00:00.000Z", sentAt: "2030-01-09T03:00:01.000Z", reason: null },
    webhookNotification: { status: "failed" as const, attemptedAt: "2030-01-09T03:00:00.000Z", sentAt: null, reason: "Endpoint tidak tersedia." },
    status: "open" as const, resolution: null,
  };

  assert.equal(getReminderDeliveryRefetchInterval({ failedTrainerReminders: [reminder] }), false);
  assert.equal(getReminderDeliveryRefetchInterval({ failedTrainerReminders: [] }), false);
  assert.equal(getReminderDeliveryRefetchInterval(undefined), false);
});

test("admin summary renders every safe permanent-failure detail for the manager", async () => {
  const source = await readFile(new URL("../pages/admin.tsx", import.meta.url), "utf8");
  assert.match(source, /data-testid="admin-failed-trainer-reminders"/);
  assert.match(source, /item\.trainerName/);
  assert.match(source, /item\.target/);
  assert.match(source, /item\.lastAttemptAt/);
  assert.match(source, /item\.reason/);
  assert.match(source, /Email pengelola/);
  assert.match(source, /Webhook cadangan/);
  assert.match(source, /item\.emailNotification/);
  assert.match(source, /item\.webhookNotification/);
  assert.doesNotMatch(source, /failureNotification\.destination/);
  assert.match(source, /useResolveAdminReminderEscalation/);
  assert.match(source, /useInfiniteQuery/);
  assert.match(source, /listAdminReminderEscalations/);
  assert.match(source, /filter-reminder-escalations-open/);
  assert.match(source, /filter-reminder-escalations-resolved/);
  assert.match(source, /button-load-more-reminder-escalations/);
  assert.match(source, /reminder-escalation-total/);
  assert.match(source, /whitespace-pre-wrap break-words/);
  assert.match(source, /input-reminder-resolution-note/);
  assert.match(source, /admin-reminder-escalation-history/);
});

test("admin programme catalogue separates canonical modules from read-only legacy mappings", async () => {
  const source = await readFile(new URL("../pages/admin.tsx", import.meta.url), "utf8");
  assert.match(source, /useGetAdminModuleCatalogue/);
  assert.match(source, /Baseline canonical aktif/);
  assert.match(source, /Catatan legacy yang dihentikan/);
  assert.match(source, /bukan kurikulum aktif/);
  assert.match(source, /mapping hilang/);
  assert.match(source, /mapping tidak lengkap/);
  assert.match(source, /Target canonical tidak tersedia/);
});
