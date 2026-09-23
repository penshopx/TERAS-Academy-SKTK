import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  createSignedPermanentFailureWebhookRequest,
  dueReminderKind,
  invalidTimeZoneAuditEvent,
  latestFollowUps,
  sendPermanentFailureFallback,
  verifySignedPermanentFailureWebhookRequest,
} from "./trainer-follow-up-notifications";

const now = new Date("2026-09-10T12:00:00.000Z");

test("invalid time zone incident identifies the trainer but never exposes preferences or learner data", () => {
  const event = invalidTimeZoneAuditEvent("trainer-a", "revision-a");
  assert.equal(event.entityId, "trainer-a");
  assert.equal(event.entityType, "trainer_reminder_preference");
  assert.equal(event.action, "delivery_blocked");
  assert.deepEqual(event.after, { issue: "invalid_time_zone" });
  assert.equal(event.before, null);
  assert.deepEqual(invalidTimeZoneAuditEvent("trainer-a", "revision-a"), event);
  assert.notEqual(invalidTimeZoneAuditEvent("trainer-a", "revision-b").id, event.id);
  assert.notEqual(invalidTimeZoneAuditEvent("trainer-b", "revision-a").id, event.id);
  assert.doesNotMatch(JSON.stringify(event), /revision-a|learner|Bad\/Zone/);
});

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
  const requestTimestamp = new Date("2026-09-10T12:59:59.000Z");
  const oldRequest = createSignedPermanentFailureWebhookRequest(input, oldKey, requestTimestamp);
  const activeRequest = createSignedPermanentFailureWebhookRequest(input, activeKey, requestTimestamp);
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

test("fallback transport preserves signed headers and raw body while rejecting tampering and stale timestamps", async (t) => {
  const signingKey = { id: "operations-transport-test", secret: "transport-test-secret" };
  const input = {
    trainerName: "Trainer Transport",
    target: "Observed practice",
    lastAttemptAt: new Date("2026-09-10T11:45:00.000Z"),
    reason: "Layanan email tidak dapat menyelesaikan pengiriman.",
    idempotencyKey: "notification-transport-123",
  };
  const received: Array<{ accepted: boolean; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = {
        "Content-Type": request.headers["content-type"] as "application/json",
        "Idempotency-Key": String(request.headers["idempotency-key"] ?? ""),
        "X-Teras-Webhook-Key-Id": String(request.headers["x-teras-webhook-key-id"] ?? ""),
        "X-Teras-Webhook-Timestamp": String(request.headers["x-teras-webhook-timestamp"] ?? ""),
        "X-Teras-Webhook-Signature": String(request.headers["x-teras-webhook-signature"] ?? ""),
      };
      const accepted = verifySignedPermanentFailureWebhookRequest(
        { body, headers },
        [signingKey],
        new Date(),
      );
      received.push({ accepted, body });
      response.writeHead(accepted ? 204 : 401).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/operations`;

  const previousSecret = process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET;
  const previousKeyId = process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_KEY_ID;
  process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET = signingKey.secret;
  process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_KEY_ID = signingKey.id;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET;
    else process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_SECRET = previousSecret;
    if (previousKeyId === undefined) delete process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_KEY_ID;
    else process.env.TERAS_OPERATIONS_FALLBACK_WEBHOOK_KEY_ID = previousKeyId;
  });

  await sendPermanentFailureFallback({ ...input, url });
  assert.deepEqual(received[0], {
    accepted: true,
    body: createSignedPermanentFailureWebhookRequest(input, signingKey, new Date()).body,
  });

  const currentRequest = createSignedPermanentFailureWebhookRequest(input, signingKey, new Date());
  const tamperedResponse = await fetch(url, {
    method: "POST",
    headers: currentRequest.headers,
    body: `${currentRequest.body} `,
  });
  assert.equal(tamperedResponse.status, 401);

  const staleRequest = createSignedPermanentFailureWebhookRequest(
    input,
    signingKey,
    new Date(Date.now() - 5 * 60_000 - 1_000),
  );
  const staleResponse = await fetch(url, {
    method: "POST",
    headers: staleRequest.headers,
    body: staleRequest.body,
  });
  assert.equal(staleResponse.status, 401);
  assert.deepEqual(received.map(item => item.accepted), [true, false, false]);
});
