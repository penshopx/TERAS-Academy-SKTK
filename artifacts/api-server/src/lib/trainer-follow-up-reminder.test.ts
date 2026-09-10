import assert from "node:assert/strict";
import test from "node:test";
import { followUpReminder } from "../routes/trainer";

const now = new Date("2026-09-10T12:00:00.000Z");

test("classifies active follow-up target timing without mutating its status", () => {
  assert.deepEqual(followUpReminder([], now), { status: null, timing: "unscheduled" });
  assert.deepEqual(followUpReminder([{ status: "planned", targetAt: null }], now), { status: "planned", timing: "unscheduled" });
  assert.deepEqual(followUpReminder([{ status: "planned", targetAt: new Date("2026-09-09T12:00:00.000Z") }], now), { status: "planned", timing: "overdue" });
  assert.deepEqual(followUpReminder([{ status: "in_progress", targetAt: new Date("2026-09-17T12:00:00.000Z") }], now), { status: "in_progress", timing: "due_soon" });
  assert.deepEqual(followUpReminder([{ status: "in_progress", targetAt: new Date("2026-09-18T12:00:00.000Z") }], now), { status: "in_progress", timing: "scheduled" });
});

test("completed follow-ups never produce a due reminder", () => {
  assert.deepEqual(
    followUpReminder([{ status: "completed", targetAt: new Date("2026-09-01T12:00:00.000Z") }], now),
    { status: "completed", timing: "completed" },
  );
});