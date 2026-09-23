import type { AddressInfo } from "node:net";
import {
  db,
  peopleTable,
  personRolesTable,
  trainerReminderPreferencesTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";
import type { TestAuthorizationIdentity } from "./lib/authorization";

const trainerA = "trainer-history-a";
const trainerB = "trainer-history-b";
const trainerASubject = "trainer-history-a-subject";
const trainerBSubject = "trainer-history-b-subject";
const preferenceIds = [
  "trainer-history-a-oldest",
  "trainer-history-a-tie-01",
  "trainer-history-a-tie-02",
  "trainer-history-b-oldest",
  "trainer-history-b-latest",
] as const;

type HistoryRevision = {
  id: string;
  emailEnabled: boolean;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  recordedAt: string;
};

type ActivePreferences = {
  emailEnabled: boolean;
  timeZone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  deliveryStatus: string;
  configurationIssue: string | null;
  updatedAt: string;
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function requestActivePreferences(identity: TestAuthorizationIdentity) {
  const app = createIntegrationTestApp(() => identity);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/trainer/reminder-preferences`,
    );
    const responseText = await response.text();
    assert(
      response.status === 200,
      `Expected active preferences status 200, received ${response.status}: ${responseText}`,
    );
    return JSON.parse(responseText) as ActivePreferences;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

async function requestHistory(identity: TestAuthorizationIdentity, expectedStatus = 200) {
  const app = createIntegrationTestApp(() => identity);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/trainer/reminder-preferences/history`,
    );
    const responseText = await response.text();
    assert(
      response.status === expectedStatus,
      `Expected history status ${expectedStatus}, received ${response.status}: ${responseText}`,
    );
    return JSON.parse(responseText) as HistoryRevision[] | { error: string };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

async function cleanup() {
  await db.delete(trainerReminderPreferencesTable)
    .where(inArray(trainerReminderPreferencesTable.id, [...preferenceIds]));
  await db.delete(personRolesTable)
    .where(inArray(personRolesTable.personId, [trainerA, trainerB]));
  await db.delete(peopleTable).where(inArray(peopleTable.id, [trainerA, trainerB]));
}

async function run() {
  await cleanup();
  try {
    await db.insert(peopleTable).values([
      {
        id: trainerA,
        name: "Trainer History A",
        initials: "HA",
        email: "trainer-history-a@example.test",
        role: "trainer",
        clerkUserId: trainerASubject,
        status: "active",
        createdBy: "trainer-history-test",
      },
      {
        id: trainerB,
        name: "Trainer History B",
        initials: "HB",
        email: "trainer-history-b@example.test",
        role: "trainer",
        clerkUserId: trainerBSubject,
        status: "active",
        createdBy: "trainer-history-test",
      },
    ]);
    await db.insert(personRolesTable).values([
      { personId: trainerA, role: "trainer", createdBy: "trainer-history-test" },
      { personId: trainerB, role: "trainer", createdBy: "trainer-history-test" },
    ]);
    await db.insert(trainerReminderPreferencesTable).values([
      {
        id: preferenceIds[0],
        trainerId: trainerA,
        emailEnabled: true,
        timeZone: "Asia/Jakarta",
        quietHoursStart: "20:00",
        quietHoursEnd: "06:00",
        createdAt: new Date("2026-09-10T08:00:00.000Z"),
        createdBy: trainerA,
      },
      {
        id: preferenceIds[1],
        trainerId: trainerA,
        emailEnabled: false,
        timeZone: "Asia/Makassar",
        createdAt: new Date("2026-09-12T08:00:00.000Z"),
        createdBy: trainerA,
      },
      {
        id: preferenceIds[2],
        trainerId: trainerA,
        emailEnabled: true,
        timeZone: "Asia/Jayapura",
        createdAt: new Date("2026-09-12T08:00:00.000Z"),
        createdBy: trainerA,
      },
      {
        id: preferenceIds[3],
        trainerId: trainerB,
        emailEnabled: false,
        timeZone: "UTC",
        createdAt: new Date("2026-09-09T08:00:00.000Z"),
        createdBy: trainerB,
      },
      {
        id: preferenceIds[4],
        trainerId: trainerB,
        emailEnabled: true,
        timeZone: "Asia/Jakarta",
        quietHoursStart: "22:00",
        quietHoursEnd: "05:00",
        createdAt: new Date("2026-09-13T08:00:00.000Z"),
        createdBy: trainerB,
      },
    ]);

    const historyA = await requestHistory({ userId: trainerASubject, role: "trainer" });
    assert(Array.isArray(historyA), "Trainer A history must be an array");
    assert(
      JSON.stringify(historyA.map(({ id }) => id)) === JSON.stringify([
        preferenceIds[2], preferenceIds[1], preferenceIds[0],
      ]),
      `Trainer A received another account's revisions or incorrect ordering: ${JSON.stringify(historyA)}`,
    );
    assert(
      historyA[0]?.recordedAt === historyA[1]?.recordedAt,
      "Trainer A fixture must exercise the ID tie-break with equal recordedAt values",
    );

    const activeA = await requestActivePreferences({ userId: trainerASubject, role: "trainer" });
    assert(
      activeA.emailEnabled === true
        && activeA.timeZone === "Asia/Jayapura"
        && activeA.updatedAt === historyA[0]?.recordedAt,
      `Trainer A active preferences did not select the highest ID at the tied timestamp: ${JSON.stringify(activeA)}`,
    );

    const repeatedHistoryA = await requestHistory({ userId: trainerASubject, role: "trainer" });
    assert(Array.isArray(repeatedHistoryA), "Repeated Trainer A history must be an array");
    assert(
      JSON.stringify(repeatedHistoryA.map(({ id }) => id)) === JSON.stringify([
        preferenceIds[2], preferenceIds[1], preferenceIds[0],
      ]),
      `Trainer A history ordering changed between requests: ${JSON.stringify(repeatedHistoryA)}`,
    );

    const historyB = await requestHistory({ userId: trainerBSubject, role: "trainer" });
    assert(Array.isArray(historyB), "Trainer B history must be an array");
    assert(
      JSON.stringify(historyB.map(({ id }) => id)) === JSON.stringify([
        preferenceIds[4], preferenceIds[3],
      ]),
      `Trainer B received another account's revisions or incorrect ordering: ${JSON.stringify(historyB)}`,
    );
    const activeB = await requestActivePreferences({ userId: trainerBSubject, role: "trainer" });
    assert(
      activeB.emailEnabled === true
        && activeB.timeZone === "Asia/Jakarta"
        && activeB.quietHoursStart === "22:00"
        && activeB.quietHoursEnd === "05:00"
        && activeB.updatedAt === historyB[0]?.recordedAt,
      `Trainer B active preferences were affected by another trainer's revisions: ${JSON.stringify(activeB)}`,
    );

    // Simulate legacy data (or a direct DB edit) that predates the current check constraint.
    await db.execute(sql`ALTER TABLE teras_trainer_reminder_preferences DROP CONSTRAINT teras_trainer_reminder_preferences_quiet_hours_check`);
    await db.execute(sql`UPDATE teras_trainer_reminder_preferences SET quiet_hours_start = '25:00' WHERE id = ${preferenceIds[2]}`);
    await db.execute(sql`UPDATE teras_trainer_reminder_preferences SET quiet_hours_end = '07:99' WHERE id = ${preferenceIds[0]}`);
    await db.execute(sql`UPDATE teras_trainer_reminder_preferences SET quiet_hours_end = NULL WHERE id = ${preferenceIds[4]}`);

    const brokenActiveA = await requestActivePreferences({ userId: trainerASubject, role: "trainer" });
    assert(
      brokenActiveA.quietHoursStart === null && brokenActiveA.quietHoursEnd === null
        && brokenActiveA.deliveryStatus === "disabled"
        && brokenActiveA.configurationIssue?.includes("quiet hours")
        && brokenActiveA.updatedAt === historyA[0]?.recordedAt,
      `Invalid active quiet hours must return a repair hint, not a server error: ${JSON.stringify(brokenActiveA)}`,
    );
    const brokenActiveB = await requestActivePreferences({ userId: trainerBSubject, role: "trainer" });
    assert(
      brokenActiveB.quietHoursStart === null && brokenActiveB.quietHoursEnd === null
        && brokenActiveB.deliveryStatus === "disabled"
        && brokenActiveB.configurationIssue?.includes("quiet hours"),
      `Incomplete active quiet hours must return a repair hint: ${JSON.stringify(brokenActiveB)}`,
    );
    const brokenHistoryA = await requestHistory({ userId: trainerASubject, role: "trainer" });
    const brokenHistoryB = await requestHistory({ userId: trainerBSubject, role: "trainer" });
    assert(Array.isArray(brokenHistoryA) && Array.isArray(brokenHistoryB), "Corrupt history must still load");
    assert(
      brokenHistoryA[0]?.quietHoursStart === "25:00"
        && brokenHistoryA[2]?.quietHoursEnd === "07:99"
        && brokenHistoryB[0]?.quietHoursStart === "22:00"
        && brokenHistoryB[0]?.quietHoursEnd === null,
      "Revision history must preserve the original saved values without failing validation",
    );

    const learnerResponse = await requestHistory(
      { userId: "trainer-history-learner-subject", role: "learner" },
      403,
    );
    assert(
      !Array.isArray(learnerResponse) && learnerResponse.error === "You are not authorized for this action",
      "A non-trainer must be rejected by the trainer authorization gate",
    );
  } finally {
    await cleanup();
  }
}

await run();