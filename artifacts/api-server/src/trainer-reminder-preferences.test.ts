import assert from "node:assert/strict";
import test from "node:test";
import { isWithinQuietHours, reminderDeliveryAvailability } from "./lib/trainer-follow-up-notifications";

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

test("delivery availability exposes the next local opening for cross-midnight quiet hours", () => {
  const preferences = {
    emailEnabled: true,
    timeZone: "Asia/Jakarta",
    quietHoursStart: "20:00",
    quietHoursEnd: "07:00",
  };
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T14:00:30Z"), preferences), {
    deliveryStatus: "paused_quiet_hours",
    nextDeliveryAt: new Date("2026-09-12T24:00:00Z"),
  });
});

test("delivery availability keeps the configured local opening across spring DST", () => {
  const preferences = {
    emailEnabled: true,
    timeZone: "America/New_York",
    quietHoursStart: "20:00",
    quietHoursEnd: "07:00",
  };

  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-03-08T06:30:00Z"), preferences), {
    deliveryStatus: "paused_quiet_hours",
    nextDeliveryAt: new Date("2026-03-08T11:00:00Z"),
  });
  assert.equal(isWithinQuietHours(new Date("2026-03-08T10:59:00Z"), preferences), true);
  assert.equal(isWithinQuietHours(new Date("2026-03-08T11:00:00Z"), preferences), false);
});

test("delivery availability keeps the configured local opening across fall DST", () => {
  const preferences = {
    emailEnabled: true,
    timeZone: "America/New_York",
    quietHoursStart: "20:00",
    quietHoursEnd: "07:00",
  };

  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-11-01T05:30:00Z"), preferences), {
    deliveryStatus: "paused_quiet_hours",
    nextDeliveryAt: new Date("2026-11-01T12:00:00Z"),
  });
  assert.equal(isWithinQuietHours(new Date("2026-11-01T11:59:00Z"), preferences), true);
  assert.equal(isWithinQuietHours(new Date("2026-11-01T12:00:00Z"), preferences), false);
});

test("delivery availability distinguishes active and disabled delivery", () => {
  const preferences = { timeZone: "Asia/Jakarta", quietHoursStart: "20:00", quietHoursEnd: "07:00" };
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T05:00:00Z"), { ...preferences, emailEnabled: true }), {
    deliveryStatus: "active",
    nextDeliveryAt: null,
  });
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T14:00:00Z"), { ...preferences, emailEnabled: false }), {
    deliveryStatus: "disabled",
    nextDeliveryAt: null,
  });
});

test("equal quiet-hours times remain a full-day pause with no next delivery", () => {
  const preferences = {
    emailEnabled: true,
    timeZone: "Asia/Jakarta",
    quietHoursStart: "08:00",
    quietHoursEnd: "08:00",
  };
  assert.equal(isWithinQuietHours(new Date("2026-09-12T05:00:00Z"), preferences), true);
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T05:00:00Z"), preferences), {
    deliveryStatus: "paused_quiet_hours",
    nextDeliveryAt: null,
  });
});