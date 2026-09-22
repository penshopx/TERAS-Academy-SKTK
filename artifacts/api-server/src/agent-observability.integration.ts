import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createIntegrationTestApp } from "./integration-test-app";
import { agentRunsTable, db, peopleTable, pool } from "@workspace/db";

const suffix = crypto.randomUUID();
const actor = `observability-admin-${suffix}`;
const prohibited = {
  actor: `private-actor-${suffix}`,
  objective: `private-objective-${suffix}`,
  evidence: `private-evidence-${suffix}`,
  raw: `private-raw-result-${suffix}`,
};

async function request(baseUrl: string, identity: "anonymous" | "learner" | "admin") {
  const response = await fetch(`${baseUrl}/admin/agent-observability`, {
    headers: { "x-agentic-identity": identity },
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function run() {
  const existing = await db.select({
    status: agentRunsTable.status, resultSummary: agentRunsTable.resultSummary,
    startedAt: agentRunsTable.startedAt, completedAt: agentRunsTable.completedAt,
  }).from(agentRunsTable);
  await db.insert(peopleTable).values({
    id: actor, name: "Observability Admin", initials: "OA", role: "Admin",
    organization: "Test", authProvider: "supabase", authSubject: actor,
  });
  const now = Date.now();
  const runRows = [
    { status: "COMPLETED", start: 100, summary: { claimCount: 2, actionCount: 1, fallbackUsed: false } },
    { status: "COMPLETED", start: 200, summary: { claimCount: 3, actionCount: 2, fallbackUsed: false } },
    { status: "PARTIAL", start: 300, summary: { claimCount: 1, actionCount: 0, fallbackUsed: true } },
    { status: "FAILED", start: 400, summary: { claimCount: 0, actionCount: 0, fallbackUsed: true } },
    { status: "RUNNING", start: null, summary: null },
  ] as const;
  await db.insert(agentRunsTable).values(runRows.map((row, index) => ({
    id: `observability-run-${suffix}-${index}`,
    agentId: "trainer-intelligence",
    agentVersion: `observability-${suffix}`,
    actorPersonId: actor,
    objective: prohibited.objective,
    policyDecision: "ALLOW_READ",
    toolRefs: [prohibited.evidence],
    evidenceRefs: [prohibited.evidence],
    provider: "safe-provider",
    model: "safe-model",
    status: row.status,
    resultSummary: row.summary ? { ...row.summary, raw: prohibited.raw } : null,
    resultHash: prohibited.raw,
    createdAt: new Date(now - index * 1000),
    startedAt: row.start === null ? null : new Date(now - row.start),
    completedAt: row.start === null ? null : new Date(now),
  })));
  // A legacy row is deliberately missing resultSummary fields and must not fail aggregation.
  await db.insert(agentRunsTable).values({
    id: `observability-legacy-${suffix}`, agentId: "trainer-intelligence",
    agentVersion: `observability-${suffix}`, actorPersonId: actor,
    objective: prohibited.objective, policyDecision: "ALLOW_READ",
    toolRefs: [], evidenceRefs: [], provider: "safe-provider", model: "safe-model",
    status: "COMPLETED", resultSummary: {}, resultHash: prohibited.raw,
    createdAt: new Date(now - 5000), startedAt: new Date(now - 5100), completedAt: new Date(now - 5000),
  });
  const beforeCount = Number((await pool.query("SELECT count(*) AS count FROM teras_agent_runs")).rows[0].count);
  const app = createIntegrationTestApp(req => {
    const identity = req.get("x-agentic-identity");
    if (identity === "admin") return { userId: actor, role: "admin" };
    if (identity === "learner") return { userId: `learner-${suffix}`, role: "learner" };
    return { userId: null, role: null };
  });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    assert.equal((await request(baseUrl, "anonymous")).response.status, 401);
    assert.equal((await request(baseUrl, "learner")).response.status, 403);
    const { response, body } = await request(baseUrl, "admin");
    assert.equal(response.status, 200);
    assert.equal(body.windowDays, 30);
    const allRows = [...existing, ...runRows.map(row => ({
      status: row.status, resultSummary: row.summary, startedAt: row.start === null ? null : new Date(now - row.start),
      completedAt: row.start === null ? null : new Date(now),
    })), { status: "COMPLETED", resultSummary: {}, startedAt: new Date(now - 100), completedAt: new Date(now) }];
    const latencies = allRows.flatMap(row => row.startedAt && row.completedAt ? [row.completedAt.getTime() - row.startedAt.getTime()] : []).sort((a, b) => a - b);
    const totals = {
      runCount: allRows.length, completedCount: allRows.filter(row => row.status === "COMPLETED").length,
      partialCount: allRows.filter(row => row.status === "PARTIAL").length, failedCount: allRows.filter(row => row.status === "FAILED").length,
      fallbackCount: allRows.filter(row => (row.resultSummary as any)?.fallbackUsed === true).length,
      claimCount: allRows.reduce((sum, row) => sum + (typeof (row.resultSummary as any)?.claimCount === "number" ? (row.resultSummary as any).claimCount : 0), 0),
      actionCount: allRows.reduce((sum, row) => sum + (typeof (row.resultSummary as any)?.actionCount === "number" ? (row.resultSummary as any).actionCount : 0), 0),
    };
    assert.equal(body.totals.runCount, totals.runCount);
    assert.equal(body.totals.completedCount, totals.completedCount);
    assert.equal(body.totals.partialCount, totals.partialCount);
    assert.equal(body.totals.failedCount, totals.failedCount);
    assert.equal(body.totals.fallbackCount, totals.fallbackCount);
    assert.equal(body.totals.fallbackRate, totals.fallbackCount / totals.runCount);
    assert.equal(body.totals.averageTerminalLatencyMs, latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
    assert.equal(body.totals.p95TerminalLatencyMs, latencies[Math.ceil(latencies.length * 0.95) - 1]);
    assert.equal(body.totals.claimCount, totals.claimCount);
    assert.equal(body.totals.actionCount, totals.actionCount);
    assert.deepEqual(body.dimensions.find((item: any) => item.agentVersion === `observability-${suffix}`), { agentVersion: `observability-${suffix}`, provider: "safe-provider", model: "safe-model", runCount: 6 });
    const serialized = JSON.stringify(body);
    for (const value of Object.values(prohibited)) assert.equal(serialized.includes(value), false);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM teras_agent_runs")).rows[0].count), beforeCount);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });