import {
  db,
  diagnosticFollowUpReminderDeliveriesTable,
  diagnosticProfilesTable,
  diagnosticRecommendationFollowUpsTable,
  diagnosticRecommendationsTable,
  peopleTable,
  trainerReminderPreferencesTable,
} from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { workspaceAssignmentContexts } from "./teras";

const DUE_SOON_DAYS = 7;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 30;

export type ReminderKind = "due_soon" | "overdue";

type FollowUpSnapshot = {
  id: string;
  recommendationId: string;
  trainerId: string;
  status: string;
  targetAt: Date | null;
  createdAt: Date;
};

export function dueReminderKind(followUp: Pick<FollowUpSnapshot, "status" | "targetAt">, now: Date): ReminderKind | null {
  if (followUp.status === "completed" || !followUp.targetAt) return null;
  if (followUp.targetAt.getTime() < now.getTime()) return "overdue";
  const dueSoonAt = new Date(now);
  dueSoonAt.setUTCDate(dueSoonAt.getUTCDate() + DUE_SOON_DAYS);
  return followUp.targetAt.getTime() <= dueSoonAt.getTime() ? "due_soon" : null;
}

export function latestFollowUps(rows: FollowUpSnapshot[]) {
  const latest = new Map<string, FollowUpSnapshot>();
  for (const row of rows) {
    const current = latest.get(row.recommendationId);
    if (!current || current.createdAt < row.createdAt || (current.createdAt.getTime() === row.createdAt.getTime() && current.id.localeCompare(row.id) < 0)) {
      latest.set(row.recommendationId, row);
    }
  }
  return [...latest.values()];
}

type ReminderEmailInput = { to: string; trainerName: string; learnerName: string; title: string; targetAt: Date; kind: ReminderKind };
type ReminderPreferences = {
  emailEnabled: boolean;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

export function isWithinQuietHours(now: Date, preferences: Pick<ReminderPreferences, "timeZone" | "quietHoursStart" | "quietHoursEnd">) {
  if (!preferences.quietHoursStart || !preferences.quietHoursEnd) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: preferences.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find(part => part.type === "hour")?.value;
  const minute = parts.find(part => part.type === "minute")?.value;
  if (!hour || !minute) return false;
  const current = `${hour}:${minute}`;
  const { quietHoursStart: start, quietHoursEnd: end } = preferences;
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

async function latestReminderPreferences(trainerId: string): Promise<ReminderPreferences> {
  const [latest] = await db.select().from(trainerReminderPreferencesTable)
    .where(eq(trainerReminderPreferencesTable.trainerId, trainerId))
    .orderBy(desc(trainerReminderPreferencesTable.createdAt), desc(trainerReminderPreferencesTable.id))
    .limit(1);
  return latest ?? { emailEnabled: true, timeZone: "Asia/Jakarta", quietHoursStart: null, quietHoursEnd: null };
}

async function sendReminderEmail(input: ReminderEmailInput) {
  const from = process.env.TERAS_NOTIFICATION_FROM;
  if (!from) throw new Error("TERAS_NOTIFICATION_FROM is not configured");
  const timing = input.kind === "overdue" ? "sudah melewati tenggat" : "mendekati tenggat";
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy("resend", "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: `Pengingat tindak lanjut TERAS: ${input.title}`,
      text: [
        `Halo ${input.trainerName},`,
        "",
        `Tindak lanjut "${input.title}" untuk ${input.learnerName} ${timing}.`,
        `Target: ${input.targetAt.toLocaleDateString("id-ID", { timeZone: "UTC" })}.`,
        "",
        "Buka dashboard trainer TERAS untuk meninjau atau memperbarui statusnya.",
        "Pengingat ini bersifat operasional dan tidak mengubah hasil diagnostic atau keputusan readiness.",
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`Resend rejected the reminder with status ${response.status}`);
}

export async function dispatchTrainerFollowUpReminders(
  now = new Date(),
  options: { sendEmail?: (input: ReminderEmailInput) => Promise<void> } = {},
) {
  if (process.env.TERAS_TRAINER_REMINDER_EMAIL_ENABLED !== "true") return { sent: 0, failed: 0, skipped: "disabled" as const };

  const followUps = await db.select().from(diagnosticRecommendationFollowUpsTable).orderBy(asc(diagnosticRecommendationFollowUpsTable.createdAt));
  const candidates = latestFollowUps(followUps).flatMap((followUp) => {
    const kind = dueReminderKind(followUp, now);
    return kind ? [{ followUp, kind }] : [];
  });
  if (!candidates.length) return { sent: 0, failed: 0 };

  const recommendationIds = [...new Set(candidates.map(({ followUp }) => followUp.recommendationId))];
  const trainerIds = [...new Set(candidates.map(({ followUp }) => followUp.trainerId))];
  const recommendations = await db.select().from(diagnosticRecommendationsTable).where(inArray(diagnosticRecommendationsTable.id, recommendationIds));
  const profiles = await db.select().from(diagnosticProfilesTable).where(inArray(diagnosticProfilesTable.id, [...new Set(recommendations.map(item => item.profileId))]));
  const people = await db.select().from(peopleTable).where(inArray(peopleTable.id, [...new Set([...trainerIds, ...profiles.map(item => item.learnerId)])]));
  const recommendationById = new Map(recommendations.map(item => [item.id, item]));
  const profileById = new Map(profiles.map(item => [item.id, item]));
  const personById = new Map(people.map(item => [item.id, item]));
  const currentScopes = new Map<string, Set<string>>();
  await Promise.all(trainerIds.map(async trainerId => {
    const contexts = await workspaceAssignmentContexts(trainerId, "trainer");
    currentScopes.set(trainerId, new Set(contexts.map(context => `${context.learner.id}:${context.pathway.id}`)));
  }));
  let sent = 0;
  let failed = 0;

  for (const { followUp, kind } of candidates) {
    const trainer = personById.get(followUp.trainerId);
    const recommendation = recommendationById.get(followUp.recommendationId);
    const profile = recommendation && profileById.get(recommendation.profileId);
    const learner = profile && personById.get(profile.learnerId);
    if (!trainer?.email || trainer.status !== "active" || !recommendation || !learner || !followUp.targetAt) continue;
    if (!currentScopes.get(trainer.id)?.has(`${profile.learnerId}:${profile.pathwayId}`)) continue;
    const preferences = await latestReminderPreferences(trainer.id);
    if (!preferences.emailEnabled || isWithinQuietHours(now, preferences)) continue;

    const deliveryId = `follow-up-reminder-${crypto.randomUUID()}`;
    await db.insert(diagnosticFollowUpReminderDeliveriesTable).values({
      id: deliveryId,
      followUpId: followUp.id,
      trainerId: trainer.id,
      channel: "email",
      reminderKind: kind,
      destination: trainer.email,
      createdBy: "trainer-follow-up-reminder-scheduler",
    }).onConflictDoNothing();

    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MINUTES * 60_000);
    const [claimed] = await db.update(diagnosticFollowUpReminderDeliveriesTable)
      .set({
        status: "sending",
        attemptCount: sql`${diagnosticFollowUpReminderDeliveriesTable.attemptCount} + 1`,
        lastAttemptAt: now,
        failureReason: null,
      })
      .where(and(
        eq(diagnosticFollowUpReminderDeliveriesTable.followUpId, followUp.id),
        eq(diagnosticFollowUpReminderDeliveriesTable.reminderKind, kind),
        eq(diagnosticFollowUpReminderDeliveriesTable.channel, "email"),
        lt(diagnosticFollowUpReminderDeliveriesTable.attemptCount, MAX_ATTEMPTS),
        or(
          eq(diagnosticFollowUpReminderDeliveriesTable.status, "pending"),
          eq(diagnosticFollowUpReminderDeliveriesTable.status, "failed"),
          and(eq(diagnosticFollowUpReminderDeliveriesTable.status, "sending"), lt(diagnosticFollowUpReminderDeliveriesTable.lastAttemptAt, retryBefore)),
        ),
      ))
      .returning();
    if (!claimed) continue;

    try {
      await (options.sendEmail ?? sendReminderEmail)({ to: trainer.email, trainerName: trainer.name, learnerName: learner.name, title: recommendation.title, targetAt: followUp.targetAt, kind });
      await db.update(diagnosticFollowUpReminderDeliveriesTable).set({ status: "sent", sentAt: new Date(), failureReason: null }).where(eq(diagnosticFollowUpReminderDeliveriesTable.id, claimed.id));
      sent += 1;
    } catch (error) {
      const failureReason = error instanceof Error ? error.message.slice(0, 500) : "Unknown reminder delivery failure";
      await db.update(diagnosticFollowUpReminderDeliveriesTable).set({ status: "failed", failureReason }).where(eq(diagnosticFollowUpReminderDeliveriesTable.id, claimed.id));
      logger.warn({ deliveryId: claimed.id, followUpId: followUp.id, attemptCount: claimed.attemptCount, error: failureReason }, "Trainer follow-up reminder delivery failed");
      failed += 1;
    }
  }
  return { sent, failed };
}

export function startTrainerFollowUpReminderScheduler() {
  if (process.env.NODE_ENV === "test" || process.env.TERAS_TRAINER_REMINDER_EMAIL_ENABLED !== "true") return;
  const run = () => dispatchTrainerFollowUpReminders().then(
    result => logger.info(result, "Trainer follow-up reminder dispatch completed"),
    error => logger.error({ err: error }, "Trainer follow-up reminder dispatch crashed"),
  );
  const initial = setTimeout(run, 10_000);
  const interval = setInterval(run, 15 * 60_000);
  initial.unref();
  interval.unref();
}