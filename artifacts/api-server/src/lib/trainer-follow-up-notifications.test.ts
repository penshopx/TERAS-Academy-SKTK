import assert from "node:assert/strict";
import test from "node:test";
import { dueReminderKind, latestFollowUps } from "./trainer-follow-up-notifications";

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