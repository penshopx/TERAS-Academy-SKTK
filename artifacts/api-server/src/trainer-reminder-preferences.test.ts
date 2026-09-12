import assert from "node:assert/strict";
import test from "node:test";
import { isWithinQuietHours } from "./lib/trainer-follow-up-notifications";

test("quiet hours use the trainer time zone and can cross midnight", () => {
  const preferences = {
    timeZone: "Asia/Jakarta",
    quietHoursStart: "20:00",
    quietHoursEnd: "07:00",
  };

  assert.equal(isWithinQuietHours(new Date("2026-09-12T14:00:00Z"), preferences), true);
  assert.equal(isWithinQuietHours(new Date("2026-09-12T23:59:00Z"), preferences), true);
  assert.equal(isWithinQuietHours(new Date("2026-09-12T05:00:00Z"), preferences), false);
});

test("quiet hours can use a same-day interval or be disabled", () => {
  assert.equal(isWithinQuietHours(new Date("2026-09-12T05:00:00Z"), {
    timeZone: "Asia/Jakarta",
    quietHoursStart: "11:00",
    quietHoursEnd: "14:00",
  }), true);
  assert.equal(isWithinQuietHours(new Date("2026-09-12T05:00:00Z"), {
    timeZone: "Asia/Jakarta",
    quietHoursStart: null,
    quietHoursEnd: null,
  }), false);
});