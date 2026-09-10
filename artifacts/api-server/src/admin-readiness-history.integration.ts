import { inArray } from "drizzle-orm";
import {
  db, enrollmentsTable, pathwaysTable, peopleTable, programsTable, readinessEventsTable, readinessGatesTable,
} from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const suffix = crypto.randomUUID();
const id = (label: string) => `readiness-audit-${label}-${suffix}`;
const ids = {
  learnerA: id("learner-a"), learnerB: id("learner-b"), program: id("program"),
  pathwayA: id("path-a"), pathwayB: id("path-b"), enrollmentA: id("enrollment-a"),
  enrollmentB: id("enrollment-b"), gateA: id("gate-a"), gateB: id("gate-b"),
  eventA: id("event-a"), eventB: id("event-b"), eventC: id("event-c"),
};

async function run() {
  await db.insert(peopleTable).values([
    { id: ids.learnerA, name: "Audit Learner A", initials: "AA", role: "learner", status: "active" },
    { id: ids.learnerB, name: "Audit Learner B", initials: "AB", role: "learner", status: "active" },
  ]);
  await db.insert(programsTable).values({ id: ids.program, domain: "Audit", name: "Audit", description: "Audit test", status: "active" });
  await db.insert(pathwaysTable).values([
    { id: ids.pathwayA, programId: ids.program, name: "Audit Path A", type: "test", outcome: "test" },
    { id: ids.pathwayB, programId: ids.program, name: "Audit Path B", type: "test", outcome: "test" },
  ]);
  await db.insert(enrollmentsTable).values([
    { id: ids.enrollmentA, learnerId: ids.learnerA, programId: ids.program, pathwayId: ids.pathwayA },
    { id: ids.enrollmentB, learnerId: ids.learnerB, programId: ids.program, pathwayId: ids.pathwayB },
  ]);
  await db.insert(readinessGatesTable).values([
    { id: ids.gateA, programId: ids.program, pathwayId: ids.pathwayA, sequence: 1, code: "A1", name: "Audit Gate A", requirement: "A", ruleVersion: 2 },
    { id: ids.gateB, programId: ids.program, pathwayId: ids.pathwayB, sequence: 1, code: "B1", name: "Audit Gate B", requirement: "B", ruleVersion: 3 },
  ]);
  await db.insert(readinessEventsTable).values([
    {
      id: ids.eventA, enrollmentId: ids.enrollmentA, pathwayId: ids.pathwayA, gateId: ids.gateA,
      status: "Developing", score: 72, blockers: ["Evidence pending"], ruleVersion: 2,
      inputEvidence: { assessments: [{ id: "assessment-a", score: 72, completed: true, criticalFailure: false }], evidence: [{ requirementId: "evidence-a", satisfied: false }], openCriticalGaps: [] },
      decisionReason: "Evidence is incomplete", evaluatedAt: new Date("2026-01-01T10:00:00Z"),
    },
    {
      id: ids.eventB, enrollmentId: ids.enrollmentB, pathwayId: ids.pathwayB, gateId: ids.gateB,
      status: "Not Ready", score: 40, blockers: ["Critical safety"], ruleVersion: 3,
      inputEvidence: { assessments: [{ id: "assessment-b", score: 40, completed: true, criticalFailure: true }], evidence: [], openCriticalGaps: ["gap-b"] },
      decisionReason: "Critical safety failure", evaluatedAt: new Date("2026-01-02T10:00:00Z"),
    },
    {
      id: ids.eventC, enrollmentId: ids.enrollmentB, pathwayId: ids.pathwayB, gateId: ids.gateB,
      status: "Not Ready", score: 45, blockers: ["Critical safety"], ruleVersion: 3,
      inputEvidence: { assessments: [], evidence: [], openCriticalGaps: ["gap-c"] },
      decisionReason: "Critical gap remains open", evaluatedAt: new Date("2026-01-02T10:00:00Z"),
    },
  ]);

  const app = createIntegrationTestApp(req => {
    const role = req.get("x-test-role");
    return { userId: `${role ?? "anonymous"}-readiness-audit`, role: role === "admin" ? "admin" : role === "learner" ? "learner" : null };
  });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Test server did not bind");
  const request = (path: string, role: "admin" | "learner") => fetch(`http://127.0.0.1:${address.port}/api${path}`, { headers: { "x-test-role": role } });

  try {
    const forbidden = await request("/admin/readiness-history", "learner");
    assert(forbidden.status === 403, "Learners must not access readiness audit history");

    const filteredResponse = await request(`/admin/readiness-history?learnerId=${ids.learnerA}&pathwayId=${ids.pathwayA}&status=Developing&ruleVersion=2&page=1&pageSize=1`, "admin");
    const filtered = await filteredResponse.json() as any;
    assert(filteredResponse.status === 200 && filtered.items.length === 1, "All readiness history filters must be applied together");
    assert(filtered.total === 1 && filtered.page === 1 && filtered.pageSize === 1, "History must report accurate pagination metadata");
    assert(filtered.items[0].id === ids.eventA && filtered.items[0].learnerName === "Audit Learner A", "Filtered history must preserve learner context");
    assert(filtered.items[0].inputEvidence.evidence[0].requirementId === "evidence-a", "History must include the immutable evidence snapshot");

    const firstPageResponse = await request("/admin/readiness-history?page=1&pageSize=1", "admin");
    const firstPage = await firstPageResponse.json() as any;
    assert(firstPage.items.length === 1 && firstPage.total >= 2, "Page size must bound records without changing the total");

    const secondPageResponse = await request("/admin/readiness-history?page=2&pageSize=1", "admin");
    const secondPage = await secondPageResponse.json() as any;
    assert(secondPage.items.length === 1 && secondPage.items[0].id !== firstPage.items[0].id, "Distinct pages must return distinct readiness events");

    const exportResponse = await request(`/admin/readiness-history/export?status=Not%20Ready&ruleVersion=3`, "admin");
    const exported = await exportResponse.json() as any;
    assert(exportResponse.status === 200 && exportResponse.headers.get("cache-control") === "private, no-store", "Audit export must be private and non-cacheable");
    assert(exported.schemaVersion === "1.0" && exported.recordCount === 2, "Export must be versioned and report its record count");
    assert(exported.records.some((record: any) => record.id === ids.eventB && record.inputEvidence.openCriticalGaps[0] === "gap-b"), "Export must include complete decision snapshots");
    assert(exported.records.some((record: any) => record.id === ids.eventC), "Export must preserve records with identical evaluation timestamps");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(readinessEventsTable).where(inArray(readinessEventsTable.id, [ids.eventA, ids.eventB, ids.eventC]));
    await db.delete(readinessGatesTable).where(inArray(readinessGatesTable.id, [ids.gateA, ids.gateB]));
    await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, [ids.enrollmentA, ids.enrollmentB]));
    await db.delete(pathwaysTable).where(inArray(pathwaysTable.id, [ids.pathwayA, ids.pathwayB]));
    await db.delete(programsTable).where(inArray(programsTable.id, [ids.program]));
    await db.delete(peopleTable).where(inArray(peopleTable.id, [ids.learnerA, ids.learnerB]));
  }
}

await run();