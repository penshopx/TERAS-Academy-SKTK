import type { AddressInfo } from "node:net";
import {
  db,
  peopleTable,
  personRolesTable,
  trainerReminderPreferencesTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createIntegrationTestApp } from "./integration-test-app";
import type { TestAuthorizationIdentity } from "./lib/authorization";

const trainerA = "trainer-history-a";
const trainerB = "trainer-history-b";
const trainerASubject = "trainer-history-a-subject";
const trainerBSubject = "trainer-history-b-subject";
const preferenceIds = [
  "trainer-history-a-oldest",
  "trainer-history-a-middle",
  "trainer-history-a-latest",
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

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
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
        createdAt: new Date("2026-09-11T08:00:00.000Z"),
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

    const historyB = await requestHistory({ userId: trainerBSubject, role: "trainer" });
    assert(Array.isArray(historyB), "Trainer B history must be an array");
    assert(
      JSON.stringify(historyB.map(({ id }) => id)) === JSON.stringify([
        preferenceIds[4], preferenceIds[3],
      ]),
      `Trainer B received another account's revisions or incorrect ordering: ${JSON.stringify(historyB)}`,
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