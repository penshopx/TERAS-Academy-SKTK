import {
  db,
  diagnosticFollowUpFailureNotificationsTable,
  diagnosticFollowUpReminderDeliveriesTable,
  diagnosticProfilesTable,
  diagnosticRecommendationFollowUpsTable,
  diagnosticRecommendationsTable,
  peopleTable,
  trainerReminderPreferencesTable,
} from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { logger } from "./logger";
import { workspaceAssignmentContexts } from "./teras";

const DUE_SOON_DAYS = 7;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 30;

export type ReminderKind = "due_soon" | "overdue";

export function safeReminderFailureReason(reason: string | null) {
  if (!reason) return "Pengiriman email gagal setelah tiga percobaan.";
  if (reason.includes("TERAS_NOTIFICATION_FROM")) return "Konfigurasi pengirim email belum tersedia.";
  if (reason.includes("Resend rejected")) return "Layanan email menolak pengiriman.";
  return "Layanan email tidak dapat menyelesaikan pengiriman.";
}

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
export type PermanentFailureNotificationInput = {
  to: string;
  trainerName: string;
  target: string;
  lastAttemptAt: Date;
  reason: string;
  idempotencyKey: string;
};
export type PermanentFailureFallbackInput = Omit<PermanentFailureNotificationInput, "to"> & { url: string };
export type SignedWebhookRequest = {
  body: string;
  headers: {
    "Content-Type": "application/json";
    "Idempotency-Key": string;
    "X-Teras-Webhook-Timestamp": string;
    "X-Teras-Webhook-Signature": string;
  };
};
type ReminderPreferences = {
  emailEnabled: boolean;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

export type ReminderDeliveryAvailability = {
  deliveryStatus: "active" | "paused_quiet_hours" | "disabled";
  nextDeliveryAt: Date | null;
  configurationIssue: string | null;
};

const INVALID_TIME_ZONE_MESSAGE = "The saved time zone is invalid. Choose a valid IANA time zone to resume reminder delivery.";

export function isValidIanaTimeZone(timeZone: string) {
  if (/^[+-]\d{2}(?::?\d{2})?$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function isWithinQuietHours(now: Date, preferences: Pick<ReminderPreferences, "timeZone" | "quietHoursStart" | "quietHoursEnd">) {
  if (!preferences.quietHoursStart || !preferences.quietHoursEnd) return false;
  if (!isValidIanaTimeZone(preferences.timeZone)) return false;
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

export function reminderDeliveryAvailability(
  now: Date,
  preferences: ReminderPreferences,
): ReminderDeliveryAvailability {
  if (!isValidIanaTimeZone(preferences.timeZone)) {
    return { deliveryStatus: "disabled", nextDeliveryAt: null, configurationIssue: INVALID_TIME_ZONE_MESSAGE };
  }
  if (!preferences.emailEnabled) return { deliveryStatus: "disabled", nextDeliveryAt: null, configurationIssue: null };
  if (!isWithinQuietHours(now, preferences)) return { deliveryStatus: "active", nextDeliveryAt: null, configurationIssue: null };

  const nextMinute = new Date(now);
  nextMinute.setUTCSeconds(0, 0);
  nextMinute.setUTCMinutes(nextMinute.getUTCMinutes() + 1);
  for (let offset = 0; offset <= 48 * 60; offset += 1) {
    const candidate = new Date(nextMinute.getTime() + offset * 60_000);
    if (!isWithinQuietHours(candidate, preferences)) {
      return { deliveryStatus: "paused_quiet_hours", nextDeliveryAt: candidate, configurationIssue: null };
    }
  }
  return { deliveryStatus: "paused_quiet_hours", nextDeliveryAt: null, configurationIssue: null };
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

async function sendPermanentFailureNotification(input: PermanentFailureNotificationInput) {
  const from = process.env.TERAS_NOTIFICATION_FROM;
  if (!from) throw new Error("TERAS_NOTIFICATION_FROM is not configured");
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy("resend", "/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: `Tindakan diperlukan: pengingat trainer gagal permanen`,
      text: [
        "Pengingat tindak lanjut TERAS gagal permanen setelah tiga percobaan.",
        "",
        `Trainer: ${input.trainerName}`,
        `Target: ${input.target}`,
        `Percobaan terakhir: ${input.lastAttemptAt.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`,
        `Alasan: ${input.reason}`,
        "",
        "Tinjau kegagalan ini di ringkasan operasional pengelola.",
        "Pemberitahuan ini tidak mengirim ulang email trainer dan tidak mengubah diagnostic atau readiness.",
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`Resend rejected the operations notification with status ${response.status}`);
}

export function createSignedPermanentFailureWebhookRequest(
  input: Omit<PermanentFailureFallbackInput, "url">,
  secret: string,
  timestamp: Date,
): SignedWebhookRequest {
  if (!secret) throw new Error("TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET is not configured");
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Webhook timestamp is invalid");

  const body = JSON.stringify({
    event: "teras.trainer_reminder.permanent_failure",
    trainerName: input.trainerName,
    target: input.target,
    lastAttemptAt: input.lastAttemptAt.toISOString(),
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  });
  const timestampSeconds = Math.floor(timestamp.getTime() / 1_000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");

  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
      "X-Teras-Webhook-Timestamp": timestampSeconds,
      "X-Teras-Webhook-Signature": `v1=${signature}`,
    },
  };
}

async function sendPermanentFailureFallback(input: PermanentFailureFallbackInput) {
  const secret = process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET;
  if (!secret) throw new Error("TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET is not configured");
  const request = createSignedPermanentFailureWebhookRequest(input, secret, new Date());
  const response = await fetch(input.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  if (!response.ok) throw new Error(`Fallback webhook rejected the operations notification with status ${response.status}`);
}

type FailureNotificationChannel = "email" | "webhook";

async function processFailureNotificationChannel(
  channel: FailureNotificationChannel,
  now: Date,
  failureByDeliveryId: Map<string, {
    deliveryId: string;
    trainerName: string;
    target: string;
    lastAttemptAt: Date | null;
    failureReason: string | null;
  }>,
  sendEmailNotification: (input: PermanentFailureNotificationInput) => Promise<void>,
  sendFallbackNotification: (input: PermanentFailureFallbackInput) => Promise<void>,
) {
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MINUTES * 60_000);
  const candidates = await db.select().from(diagnosticFollowUpFailureNotificationsTable)
    .where(and(
      eq(diagnosticFollowUpFailureNotificationsTable.channel, channel),
      or(
        eq(diagnosticFollowUpFailureNotificationsTable.status, "pending"),
        and(eq(diagnosticFollowUpFailureNotificationsTable.status, "failed"), lt(diagnosticFollowUpFailureNotificationsTable.attemptedAt, retryBefore)),
        and(eq(diagnosticFollowUpFailureNotificationsTable.status, "sending"), lt(diagnosticFollowUpFailureNotificationsTable.attemptedAt, retryBefore)),
      ),
    ));
  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const source = failureByDeliveryId.get(candidate.reminderDeliveryId);
    if (!source?.lastAttemptAt) continue;
    const [claimed] = await db.update(diagnosticFollowUpFailureNotificationsTable)
      .set({ status: "sending", attemptedAt: now, failureReason: null })
      .where(and(
        eq(diagnosticFollowUpFailureNotificationsTable.id, candidate.id),
        or(
          eq(diagnosticFollowUpFailureNotificationsTable.status, "pending"),
          and(eq(diagnosticFollowUpFailureNotificationsTable.status, "failed"), lt(diagnosticFollowUpFailureNotificationsTable.attemptedAt, retryBefore)),
          and(eq(diagnosticFollowUpFailureNotificationsTable.status, "sending"), lt(diagnosticFollowUpFailureNotificationsTable.attemptedAt, retryBefore)),
        ),
      ))
      .returning();
    if (!claimed) continue;
    const common = {
      trainerName: source.trainerName,
      target: source.target,
      lastAttemptAt: source.lastAttemptAt,
      reason: safeReminderFailureReason(source.failureReason),
      idempotencyKey: claimed.id,
    };
    try {
      if (channel === "email") {
        await sendEmailNotification({ ...common, to: claimed.destination });
      } else {
        await sendFallbackNotification({ ...common, url: claimed.destination });
      }
      await db.update(diagnosticFollowUpFailureNotificationsTable)
        .set({ status: "sent", sentAt: new Date(), failureReason: null })
        .where(eq(diagnosticFollowUpFailureNotificationsTable.id, claimed.id));
      sent += 1;
    } catch (error) {
      const failureReason = error instanceof Error ? error.message.slice(0, 500) : "Unknown operations notification failure";
      await db.update(diagnosticFollowUpFailureNotificationsTable)
        .set({ status: "failed", failureReason })
        .where(eq(diagnosticFollowUpFailureNotificationsTable.id, claimed.id));
      logger.warn({ deliveryId: source.deliveryId, notificationId: claimed.id, channel, error: failureReason }, "Permanent reminder failure notification failed");
      failed += 1;
    }
  }
  return { sent, failed };
}

async function dispatchPermanentFailureNotifications(
  now: Date,
  sendNotification: (input: PermanentFailureNotificationInput) => Promise<void>,
  sendFallback: (input: PermanentFailureFallbackInput) => Promise<void>,
) {
  const destination = process.env.TERAS_OPERATIONS_NOTIFICATION_EMAIL ?? process.env.TERAS_SUPER_ADMIN_OWNER_EMAIL;
  const fallbackDestination = process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_URL;
  if (!destination && !fallbackDestination) {
    logger.warn("Permanent reminder failure notification destination is not configured");
    return { sent: 0, failed: 0 };
  }

  const permanentFailures = await db.select({
    deliveryId: diagnosticFollowUpReminderDeliveriesTable.id,
    trainerName: peopleTable.name,
    target: diagnosticRecommendationsTable.title,
    lastAttemptAt: diagnosticFollowUpReminderDeliveriesTable.lastAttemptAt,
    failureReason: diagnosticFollowUpReminderDeliveriesTable.failureReason,
  })
    .from(diagnosticFollowUpReminderDeliveriesTable)
    .innerJoin(diagnosticRecommendationFollowUpsTable, eq(diagnosticRecommendationFollowUpsTable.id, diagnosticFollowUpReminderDeliveriesTable.followUpId))
    .innerJoin(diagnosticRecommendationsTable, eq(diagnosticRecommendationsTable.id, diagnosticRecommendationFollowUpsTable.recommendationId))
    .innerJoin(peopleTable, eq(peopleTable.id, diagnosticFollowUpReminderDeliveriesTable.trainerId))
    .where(eq(diagnosticFollowUpReminderDeliveriesTable.status, "permanently_failed"));

  if (destination) {
    for (const failure of permanentFailures) {
      await db.insert(diagnosticFollowUpFailureNotificationsTable).values({
        id: `follow-up-failure-notification-${crypto.randomUUID()}`,
        reminderDeliveryId: failure.deliveryId,
        channel: "email",
        destination,
        createdBy: "trainer-follow-up-reminder-scheduler",
      }).onConflictDoNothing();
    }
  }

  const failureByDeliveryId = new Map(permanentFailures.map(failure => [failure.deliveryId, failure]));
  const emailResult = await processFailureNotificationChannel("email", now, failureByDeliveryId, sendNotification, sendFallback);

  if (fallbackDestination) {
    const failedEmailNotifications = await db.select({
      reminderDeliveryId: diagnosticFollowUpFailureNotificationsTable.reminderDeliveryId,
    }).from(diagnosticFollowUpFailureNotificationsTable).where(and(
      eq(diagnosticFollowUpFailureNotificationsTable.channel, "email"),
      eq(diagnosticFollowUpFailureNotificationsTable.status, "failed"),
    ));
    for (const failedEmail of failedEmailNotifications) {
      await db.insert(diagnosticFollowUpFailureNotificationsTable).values({
        id: `follow-up-failure-fallback-${crypto.randomUUID()}`,
        reminderDeliveryId: failedEmail.reminderDeliveryId,
        channel: "webhook",
        destination: fallbackDestination,
        createdBy: "trainer-follow-up-reminder-scheduler",
      }).onConflictDoNothing();
    }
  }
  const fallbackResult = await processFailureNotificationChannel("webhook", now, failureByDeliveryId, sendNotification, sendFallback);
  return { sent: emailResult.sent + fallbackResult.sent, failed: emailResult.failed + fallbackResult.failed };
}

export async function dispatchTrainerFollowUpReminders(
  now = new Date(),
  options: {
    sendEmail?: (input: ReminderEmailInput) => Promise<void>;
    sendPermanentFailureNotification?: (input: PermanentFailureNotificationInput) => Promise<void>;
    sendPermanentFailureFallback?: (input: PermanentFailureFallbackInput) => Promise<void>;
  } = {},
) {
  if (process.env.TERAS_TRAINER_REMINDER_EMAIL_ENABLED !== "true") return { sent: 0, failed: 0, skipped: "disabled" as const };

  await db.update(diagnosticFollowUpReminderDeliveriesTable)
    .set({ status: "permanently_failed" })
    .where(and(
      eq(diagnosticFollowUpReminderDeliveriesTable.status, "failed"),
      eq(diagnosticFollowUpReminderDeliveriesTable.attemptCount, MAX_ATTEMPTS),
    ));
  await dispatchPermanentFailureNotifications(
    now,
    options.sendPermanentFailureNotification ?? sendPermanentFailureNotification,
    options.sendPermanentFailureFallback ?? sendPermanentFailureFallback,
  );

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
    if (!preferences.emailEnabled || !isValidIanaTimeZone(preferences.timeZone) || isWithinQuietHours(now, preferences)) continue;

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
      const terminal = claimed.attemptCount >= MAX_ATTEMPTS;
      await db.update(diagnosticFollowUpReminderDeliveriesTable)
        .set({ status: terminal ? "permanently_failed" : "failed", failureReason })
        .where(eq(diagnosticFollowUpReminderDeliveriesTable.id, claimed.id));
      logger.warn({ deliveryId: claimed.id, followUpId: followUp.id, attemptCount: claimed.attemptCount, error: failureReason }, "Trainer follow-up reminder delivery failed");
      failed += 1;
    }
  }
  await dispatchPermanentFailureNotifications(
    now,
    options.sendPermanentFailureNotification ?? sendPermanentFailureNotification,
    options.sendPermanentFailureFallback ?? sendPermanentFailureFallback,
  );
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