import { db, pool } from "@workspace/db";
import {
  competencyFrameworksTable,
  diagnosticFollowUpFailureNotificationsTable,
  diagnosticFollowUpReminderDeliveriesTable,
  diagnosticProfilesTable,
  diagnosticRecommendationFollowUpsTable,
  diagnosticRecommendationsTable,
  diagnosticSessionsTable,
  diagnosticTemplatesTable,
  enrollmentPathwayEventsTable,
  enrollmentsTable,
  pathwaysTable,
  peopleTable,
  programsTable,
  trainerReminderPreferencesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { dispatchTrainerFollowUpReminders } from "./lib/trainer-follow-up-notifications";

async function main() {
  await db.insert(competencyFrameworksTable).values({ id: "framework", code: "FW", name: "Framework", description: "Test", version: "1", status: "active", createdBy: "test" });
  await db.insert(programsTable).values({ id: "program", domain: "test", name: "Program", description: "Test", status: "active", createdBy: "test" });
  await db.insert(pathwaysTable).values([
    { id: "path-a", programId: "program", name: "Path A", type: "primary", outcome: "Test", status: "active", createdBy: "test" },
    { id: "path-b", programId: "program", name: "Path B", type: "primary", outcome: "Test", status: "active", createdBy: "test" },
  ]);
  await db.insert(peopleTable).values([
    { id: "learner", name: "Learner", initials: "LR", email: "learner@example.test", role: "learner", status: "active", createdBy: "test" },
    { id: "trainer-a", name: "Trainer A", initials: "TA", email: "trainer-a@example.test", role: "trainer", status: "active", createdBy: "test" },
    { id: "trainer-b", name: "Trainer B", initials: "TB", email: "trainer-b@example.test", role: "trainer", status: "active", createdBy: "test" },
  ]);
  await db.insert(enrollmentsTable).values({ id: "enrollment", learnerId: "learner", programId: "program", pathwayId: "path-a", trainerId: "trainer-a", status: "active", createdBy: "test" });
  await db.insert(diagnosticTemplatesTable).values({ id: "template", frameworkId: "framework", pathwayId: "path-a", version: "1", name: "Template", description: "Test", status: "published", createdBy: "test" });
  await db.insert(diagnosticSessionsTable).values({ id: "session", learnerId: "learner", enrollmentId: "enrollment", pathwayId: "path-a", templateId: "template", frameworkId: "framework", status: "completed", progress: 100, completedAt: new Date(), createdBy: "test" });
  await db.insert(diagnosticProfilesTable).values({ id: "profile", sessionId: "session", learnerId: "learner", pathwayId: "path-a", frameworkId: "framework", frameworkVersion: "1", currentState: "PRACTICE", dimensionSummaries: {}, createdBy: "test" });
  await db.insert(diagnosticRecommendationsTable).values({ id: "recommendation", profileId: "profile", frameworkId: "framework", kind: "practice", title: "Supervised practice", rationale: "Close gap", priority: "HIGH", createdBy: "test" });
  await db.insert(diagnosticRecommendationFollowUpsTable).values({ id: "follow-up", recommendationId: "recommendation", trainerId: "trainer-a", status: "planned", targetAt: new Date("2026-09-17T12:00:00Z"), note: "Plan", createdAt: new Date("2026-09-01T00:00:00Z"), createdBy: "trainer-a" });

  process.env.TERAS_TRAINER_REMINDER_EMAIL_ENABLED = "true";
  process.env.TERAS_NOTIFICATION_FROM = "TERAS <notifications@example.test>";
  process.env.TERAS_OPERATIONS_NOTIFICATION_EMAIL = "operations@example.test";
  process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_URL = "https://operations.example.test/hooks/teras";
  process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET = "integration-test-webhook-secret";
  const now = new Date("2026-09-10T12:00:00.000Z");
  let sends = 0;
  const sendEmail = async () => { sends += 1; };

  await Promise.all([
    dispatchTrainerFollowUpReminders(now, { sendEmail }),
    dispatchTrainerFollowUpReminders(now, { sendEmail }),
  ]);
  if (sends !== 1) throw new Error(`Concurrent dispatch sent ${sends} emails instead of one`);
  let audit = await db.select().from(diagnosticFollowUpReminderDeliveriesTable).where(eq(diagnosticFollowUpReminderDeliveriesTable.followUpId, "follow-up"));
  if (audit[0]?.status !== "sent" || audit[0]?.attemptCount !== 1) throw new Error("Successful delivery audit was not persisted");

  await db.delete(diagnosticFollowUpReminderDeliveriesTable);
  sends = 0;
  await db.insert(trainerReminderPreferencesTable).values({
    id: "preference-disabled",
    trainerId: "trainer-a",
    emailEnabled: false,
    timeZone: "Asia/Jakarta",
    createdAt: new Date("2026-09-10T10:00:00Z"),
    createdBy: "trainer-a",
  });
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  if (sends !== 0 || (await db.select().from(diagnosticFollowUpReminderDeliveriesTable)).length !== 0) throw new Error("Disabled trainer reminder preference was ignored");

  await db.insert(trainerReminderPreferencesTable).values({
    id: "preference-quiet",
    trainerId: "trainer-a",
    emailEnabled: true,
    timeZone: "Asia/Jakarta",
    quietHoursStart: "18:00",
    quietHoursEnd: "20:00",
    createdAt: new Date("2026-09-10T10:01:00Z"),
    createdBy: "trainer-a",
  });
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  if (sends !== 0 || (await db.select().from(diagnosticFollowUpReminderDeliveriesTable)).length !== 0) throw new Error("Trainer quiet hours were ignored");

  await db.insert(trainerReminderPreferencesTable).values({
    id: "preference-enabled",
    trainerId: "trainer-a",
    emailEnabled: true,
    timeZone: "Asia/Jakarta",
    createdAt: new Date("2026-09-10T10:02:00Z"),
    createdBy: "trainer-a",
  });
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  if ((sends as number) !== 1) throw new Error("Latest enabled trainer reminder preference was not honored");

  await db.delete(diagnosticFollowUpReminderDeliveriesTable);
  sends = 0;
  const tiedAt = new Date("2026-09-10T10:03:00Z");
  await db.insert(trainerReminderPreferencesTable).values([
    { id: "preference-tie-z-enabled", trainerId: "trainer-a", emailEnabled: true, timeZone: "Asia/Jakarta", createdAt: tiedAt, createdBy: "trainer-a" },
    { id: "preference-tie-a-disabled", trainerId: "trainer-a", emailEnabled: false, timeZone: "Asia/Jakarta", createdAt: tiedAt, createdBy: "trainer-a" },
    { id: "preference-other-trainer", trainerId: "trainer-b", emailEnabled: false, timeZone: "Asia/Jakarta", createdAt: new Date("2026-09-10T10:04:00Z"), createdBy: "trainer-b" },
  ]);
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  const tiedDelivery = await db.select().from(diagnosticFollowUpReminderDeliveriesTable);
  if (sends !== 1 || tiedDelivery.length !== 1 || tiedDelivery[0]?.followUpId !== "follow-up" || tiedDelivery[0]?.status !== "sent") {
    throw new Error("Reminder dispatch did not select the highest-ID tied revision for its trainer");
  }

  await db.delete(diagnosticFollowUpReminderDeliveriesTable);
  await db.update(enrollmentsTable).set({ trainerId: "trainer-b" }).where(eq(enrollmentsTable.id, "enrollment"));
  sends = 0;
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  if (sends !== 0 || (await db.select().from(diagnosticFollowUpReminderDeliveriesTable)).length !== 0) throw new Error("Reminder was queued after trainer reassignment");

  await db.update(enrollmentsTable).set({ trainerId: "trainer-a", status: "inactive" }).where(eq(enrollmentsTable.id, "enrollment"));
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  if (sends !== 0) throw new Error("Reminder was sent for an inactive enrollment");

  await db.update(enrollmentsTable).set({ status: "active" }).where(eq(enrollmentsTable.id, "enrollment"));
  await db.insert(enrollmentPathwayEventsTable).values({ id: "path-change", enrollmentId: "enrollment", pathwayId: "path-b", programId: "program", sequence: 1, createdBy: "test" });
  await dispatchTrainerFollowUpReminders(now, { sendEmail });
  if (sends !== 0) throw new Error("Reminder was sent after the learner changed pathway");

  await db.delete(enrollmentPathwayEventsTable);
  await db.delete(diagnosticFollowUpReminderDeliveriesTable);
  // Rehearse an existing installation at migration 0036, then apply the same
  // additive upgrade used by post-merge reconciliation before dispatching.
  await pool.query(`
    ALTER TABLE teras_diagnostic_follow_up_failure_notifications
      DROP CONSTRAINT IF EXISTS teras_diagnostic_follow_up_failure_notification_channel_check;
    DROP INDEX IF EXISTS teras_follow_up_failure_notification_delivery_channel_unique;
    ALTER TABLE teras_diagnostic_follow_up_failure_notifications DROP COLUMN channel;
    CREATE UNIQUE INDEX teras_diagnostic_follow_up_failure_notification_delivery_unique
      ON teras_diagnostic_follow_up_failure_notifications (reminder_delivery_id);
  `);
  const fallbackMigration = await readFile(
    new URL("../../../lib/db/migrations/0041_trainer_reminder_failure_fallback.sql", import.meta.url),
    "utf8",
  );
  await pool.query(fallbackMigration);
  let failedSends = 0;
  const operationsNotifications: unknown[] = [];
  const failingSender = async () => { failedSends += 1; throw new Error("simulated transport failure"); };
  const fallbackNotifications: unknown[] = [];
  const failingOperationsNotification = async (input: unknown) => { operationsNotifications.push(input); throw new Error("simulated operations email failure"); };
  const captureFallbackNotification = async (input: unknown) => { fallbackNotifications.push(input); };
  await dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender, sendPermanentFailureNotification: failingOperationsNotification, sendPermanentFailureFallback: captureFallbackNotification });
  await dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender, sendPermanentFailureNotification: failingOperationsNotification, sendPermanentFailureFallback: captureFallbackNotification });
  await Promise.all([
    dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender, sendPermanentFailureNotification: failingOperationsNotification, sendPermanentFailureFallback: captureFallbackNotification }),
    dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender, sendPermanentFailureNotification: failingOperationsNotification, sendPermanentFailureFallback: captureFallbackNotification }),
  ]);
  audit = await db.select().from(diagnosticFollowUpReminderDeliveriesTable).where(eq(diagnosticFollowUpReminderDeliveriesTable.followUpId, "follow-up"));
  if (audit[0]?.status !== "permanently_failed" || audit[0]?.attemptCount !== 3) throw new Error("Failed delivery did not become a terminal escalation after three audited attempts");
  if (failedSends !== 3) throw new Error(`Terminal delivery was attempted ${failedSends} times instead of three`);
  if (operationsNotifications.length !== 1) throw new Error(`Permanent failure produced ${operationsNotifications.length} operations notifications instead of one`);
  if (fallbackNotifications.length !== 1) throw new Error(`Failed operations email produced ${fallbackNotifications.length} fallback notifications instead of one`);
  const notification = operationsNotifications[0] as any;
  if (notification.trainerName !== "Trainer A" || notification.target !== "Supervised practice" || notification.lastAttemptAt?.toISOString() !== now.toISOString()) {
    throw new Error("Operations notification did not identify trainer, target, and last attempt time");
  }
  if (notification.reason !== "Layanan email tidak dapat menyelesaikan pengiriman." || JSON.stringify(notification).includes("simulated transport failure")) {
    throw new Error("Operations notification exposed an unsafe delivery failure reason");
  }
  const notificationAudit = await db.select().from(diagnosticFollowUpFailureNotificationsTable);
  const emailAudit = notificationAudit.find(item => item.channel === "email");
  const fallbackAudit = notificationAudit.find(item => item.channel === "webhook");
  if (notificationAudit.length !== 2 || emailAudit?.status !== "failed" || fallbackAudit?.status !== "sent") throw new Error("Per-channel operations notification audits were not persisted idempotently");
  if (notification.idempotencyKey !== emailAudit.id) throw new Error("Operations notification did not use its stable audit identity as the provider idempotency key");
  if ((fallbackNotifications[0] as any).idempotencyKey !== fallbackAudit.id) throw new Error("Fallback notification did not use its own stable audit identity");

  await db.update(diagnosticFollowUpFailureNotificationsTable)
    .set({ status: "sending", attemptedAt: new Date("2026-09-10T11:00:00.000Z"), sentAt: null })
    .where(eq(diagnosticFollowUpFailureNotificationsTable.id, fallbackAudit.id));
  const recoveredNotifications: any[] = [];
  await dispatchTrainerFollowUpReminders(new Date("2026-09-10T12:31:00.000Z"), {
    sendEmail: async () => { throw new Error("Trainer email must not be retried while recovering the operations outbox"); },
    sendPermanentFailureNotification: async () => { throw new Error("Operations email must not be retried before its retry window"); },
    sendPermanentFailureFallback: async input => { recoveredNotifications.push(input); },
  });
  if (recoveredNotifications.length !== 1) throw new Error("A stale operations notification claim was not recovered");
  if (recoveredNotifications[0].idempotencyKey !== fallbackAudit.id) throw new Error("Recovered fallback notification changed its provider idempotency key");
  const recoveredAudit = await db.select().from(diagnosticFollowUpFailureNotificationsTable);
  const recoveredFallbackAudit = recoveredAudit.find(item => item.channel === "webhook");
  if (recoveredFallbackAudit?.status !== "sent" || !recoveredFallbackAudit.sentAt) throw new Error("Recovered fallback notification did not reach a sent audit state");
  if (failedSends !== 3) throw new Error("Recovering the operations outbox retried the trainer email");
}

main().then(
  async () => { await pool.end(); },
  async error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    if (error && typeof error === "object" && "cause" in error) {
      const cause = error.cause;
      process.stderr.write(`Cause: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
    }
    await pool.end();
    process.exitCode = 1;
  },
);