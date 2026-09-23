import assert from "node:assert/strict";
import test from "node:test";
import app from "./app";
import { hasValidQuietHours, isValidIanaTimeZone, isWithinQuietHours, reminderDeliveryAvailability } from "./lib/trainer-follow-up-notifications";

test("reminder preferences accept recognized IANA time zones", () => {
  assert.equal(isValidIanaTimeZone("Asia/Jakarta"), true);
  assert.equal(isValidIanaTimeZone("America/New_York"), true);
});

test("reminder preferences reject unrecognized IANA time zones", () => {
  assert.equal(isValidIanaTimeZone("Invalid/Time_Zone"), false);
  assert.equal(isValidIanaTimeZone(""), false);
  assert.equal(isValidIanaTimeZone("+01:00"), false);
  assert.equal(isValidIanaTimeZone("-2359"), false);
});

test("legacy invalid reminder time zones return a controlled repair response", () => {
  const preferences = {
    emailEnabled: true,
    timeZone: "Invalid/Legacy_Zone",
    quietHoursStart: "20:00",
    quietHoursEnd: "07:00",
  };

  assert.equal(isWithinQuietHours(new Date("2026-09-12T14:00:00Z"), preferences), false);
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T14:00:00Z"), preferences), {
    deliveryStatus: "disabled",
    nextDeliveryAt: null,
    configurationIssue: "The saved time zone is invalid. Choose a valid IANA time zone to resume reminder delivery.",
  });
});

test("legacy invalid quiet hours disable delivery and request repair", () => {
  for (const [quietHoursStart, quietHoursEnd] of [
    ["25:00", "07:00"],
    ["20:00", "07:99"],
    ["20:00:00", "07:00"],
    [null, "07:00"],
    ["20:00", null],
  ] as const) {
    const preferences = { emailEnabled: true, timeZone: "Asia/Jakarta", quietHoursStart, quietHoursEnd };
    assert.equal(hasValidQuietHours(preferences), false);
    assert.equal(isWithinQuietHours(new Date("2026-09-12T14:00:00Z"), preferences), false);
    assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T14:00:00Z"), preferences), {
      deliveryStatus: "disabled",
      nextDeliveryAt: null,
      configurationIssue: "The saved quiet hours are invalid. Choose valid start and end times or turn off quiet hours to resume reminder delivery.",
    });
  }
});

test("saving an invalid reminder time zone returns a clear validation response before persistence", async () => {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === "object");

    for (const timeZone of ["Invalid/Time_Zone", "+01:00"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/trainer/reminder-preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailEnabled: true,
          timeZone,
          quietHoursStart: null,
          quietHoursEnd: null,
          confirmFullDayQuietHours: false,
        }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Time zone must be a valid IANA time zone",
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

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
    configurationIssue: null,
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
    configurationIssue: null,
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
    configurationIssue: null,
  });
  assert.equal(isWithinQuietHours(new Date("2026-11-01T11:59:00Z"), preferences), true);
  assert.equal(isWithinQuietHours(new Date("2026-11-01T12:00:00Z"), preferences), false);
});

test("delivery availability distinguishes active and disabled delivery", () => {
  const preferences = { timeZone: "Asia/Jakarta", quietHoursStart: "20:00", quietHoursEnd: "07:00" };
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T05:00:00Z"), { ...preferences, emailEnabled: true }), {
    deliveryStatus: "active",
    nextDeliveryAt: null,
    configurationIssue: null,
  });
  assert.deepEqual(reminderDeliveryAvailability(new Date("2026-09-12T14:00:00Z"), { ...preferences, emailEnabled: false }), {
    deliveryStatus: "disabled",
    nextDeliveryAt: null,
    configurationIssue: null,
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
    configurationIssue: null,
  });
});