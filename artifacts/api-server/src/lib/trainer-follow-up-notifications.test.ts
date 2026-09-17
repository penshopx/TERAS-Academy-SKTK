import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createSignedPermanentFailureWebhookRequest,
  dueReminderKind,
  latestFollowUps,
  verifySignedPermanentFailureWebhookRequest,
} from "./trainer-follow-up-notifications";

const now = new Date("2026-09-10T12:00:00.000Z");

test("only active follow-ups near or past their target are eligible", () => {
  assert.equal(dueReminderKind({ status: "planned", targetAt: new Date("2026-09-17T12:00:00.000Z") }, now), "due_soon");
  assert.equal(dueReminderKind({ status: "in_progress", targetAt: new Date("2026-09-09T12:00:00.000Z") }, now), "overdue");
  assert.equal(dueReminderKind({ status: "planned", targetAt: new Date("2026-09-18T12:00:00.000Z") }, now), null);
  assert.equal(dueReminderKind({ status: "completed", targetAt: new Date("2026-09-09T12:00:00.000Z") }, now), null);
  assert.equal(dueReminderKind({ status: "planned", targetAt: null }, now), null);
});

test("a completed latest event suppresses reminders for the earlier active state", () => {
  const rows = [
    { id: "first", recommendationId: "recommendation", trainerId: "trainer", status: "planned", targetAt: new Date("2026-09-09T12:00:00.000Z"), createdAt: new Date("2026-09-01T00:00:00.000Z") },
    { id: "second", recommendationId: "recommendation", trainerId: "trainer", status: "completed", targetAt: new Date("2026-09-09T12:00:00.000Z"), createdAt: new Date("2026-09-02T00:00:00.000Z") },
  ];
  const [latest] = latestFollowUps(rows);
  assert.equal(latest?.id, "second");
  assert.equal(latest && dueReminderKind(latest, now), null);
});

test("fallback webhook signatures are stable, payload-bound, and timestamp-bound", () => {
  const input = {
    trainerName: "Trainer A",
    target: "Supervised practice",
    lastAttemptAt: new Date("2026-09-10T11:45:00.000Z"),
    reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    idempotencyKey: "notification-123",
  };
  const timestamp = new Date("2026-09-10T12:00:00.000Z");
  const signingKey = { id: "operations-2026-09", secret: "test-webhook-secret" };
  const first = createSignedPermanentFailureWebhookRequest(input, signingKey, timestamp);
  const repeated = createSignedPermanentFailureWebhookRequest(input, signingKey, timestamp);

  assert.deepEqual(repeated, first);
  assert.equal(first.headers["X-Teras-Webhook-Key-Id"], signingKey.id);
  assert.equal(first.headers["X-Teras-Webhook-Timestamp"], "1789041600");
  assert.equal(
    first.headers["X-Teras-Webhook-Signature"],
    `v1=${createHmac("sha256", signingKey.secret).update(`1789041600.${first.body}`, "utf8").digest("hex")}`,
  );
  assert.notEqual(
    createSignedPermanentFailureWebhookRequest({ ...input, target: "Changed target" }, signingKey, timestamp).headers["X-Teras-Webhook-Signature"],
    first.headers["X-Teras-Webhook-Signature"],
  );
  assert.notEqual(
    createSignedPermanentFailureWebhookRequest(input, signingKey, new Date(timestamp.getTime() + 1_000)).headers["X-Teras-Webhook-Signature"],
    first.headers["X-Teras-Webhook-Signature"],
  );
});

test("secret rotation preserves payload and accepts the old key only during its transition window", () => {
  const input = {
    trainerName: "Trainer A",
    target: "Supervised practice",
    lastAttemptAt: new Date("2026-09-10T11:45:00.000Z"),
    reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    idempotencyKey: "notification-123",
  };
  const timestamp = new Date("2026-09-10T12:00:00.000Z");
  const transitionEndsAt = new Date("2026-09-10T13:00:00.000Z");
  const oldKey = { id: "operations-2026-08", secret: "old-secret", acceptUntil: transitionEndsAt };
  const activeKey = { id: "operations-2026-09", secret: "active-secret" };
  const oldRequest = createSignedPermanentFailureWebhookRequest(input, oldKey, timestamp);
  const activeRequest = createSignedPermanentFailureWebhookRequest(input, activeKey, timestamp);
  const verificationKeys = [activeKey, oldKey];

  assert.equal(activeRequest.body, oldRequest.body);
  assert.equal(
    verifySignedPermanentFailureWebhookRequest(oldRequest, verificationKeys, new Date("2026-09-10T12:59:59.999Z")),
    true,
  );
  assert.equal(
    verifySignedPermanentFailureWebhookRequest(oldRequest, verificationKeys, new Date("2026-09-10T13:00:00.001Z")),
    false,
  );
  assert.equal(
    verifySignedPermanentFailureWebhookRequest(activeRequest, verificationKeys, new Date("2026-09-10T13:00:00.001Z")),
    true,
  );
});
