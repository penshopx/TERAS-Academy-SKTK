import { db, pool } from "@workspace/db";
import {
  competencyFrameworksTable,
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
} from "@workspace/db";
import { eq } from "drizzle-orm";
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
  const failingSender = async () => { throw new Error("simulated transport failure"); };
  await dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender });
  await dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender });
  await dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender });
  await dispatchTrainerFollowUpReminders(now, { sendEmail: failingSender });
  audit = await db.select().from(diagnosticFollowUpReminderDeliveriesTable).where(eq(diagnosticFollowUpReminderDeliveriesTable.followUpId, "follow-up"));
  if (audit[0]?.status !== "failed" || audit[0]?.attemptCount !== 3) throw new Error("Failed delivery did not stop after three audited attempts");
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