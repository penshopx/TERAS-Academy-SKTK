import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createIntegrationTestApp } from "./integration-test-app";
import { agentRunsTable, db, peopleTable, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { AGENT_HEALTH_PAGE_SIZE, openAgentCursor, sealAgentCursor, safeAgentDimension } from "./lib/agent-observability";

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
  assert.deepEqual(safeAgentDimension(prohibited.raw, prohibited.raw, prohibited.raw, prohibited.raw),
    { agentVersion: "other", provider: null, model: null });
  const cursorNow = new Date();
  const token = sealAgentCursor({ from: new Date(cursorNow.getTime() - 30 * 86400000).toISOString(), to: cursorNow.toISOString(), createdAt: cursorNow.toISOString(), id: prohibited.evidence });
  assert(!token.includes(prohibited.evidence));
  assert.equal(openAgentCursor((token.startsWith("A") ? "B" : "A") + token.slice(1)), null);
  assert.equal(openAgentCursor(token)?.id, prohibited.evidence);
  const oldTo = new Date(cursorNow.getTime() - 31 * 86400000);
  const oldToken = sealAgentCursor({ from: new Date(oldTo.getTime() - 30 * 86400000).toISOString(), to: oldTo.toISOString(), createdAt: oldTo.toISOString(), id: prohibited.evidence });
  assert.equal(openAgentCursor(oldToken), null, "Historical cursors must expire");
  const existing = await db.select({
    status: agentRunsTable.status, resultSummary: agentRunsTable.resultSummary,
    startedAt: agentRunsTable.startedAt, completedAt: agentRunsTable.completedAt,
  }).from(agentRunsTable).where(sql`${agentRunsTable.createdAt} >= now() - interval '30 days'`);
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
    provider: index === 0 ? prohibited.raw : "safe-provider",
    model: index === 0 ? prohibited.raw : "safe-model",
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
    assert((body.dimensions.find((item: any) => item.agentVersion === "other")?.runCount ?? 0) >= 6);
    assert.equal(body.policyCounts.ALLOW_READ >= 6, true);
    assert.equal(body.trends.reduce((sum: number, day: any) => sum + day.runCount, 0), body.totals.runCount);
    const serialized = JSON.stringify(body);
    for (const value of Object.values(prohibited)) assert.equal(serialized.includes(value), false);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM teras_agent_runs")).rows[0].count), beforeCount);
    assert.equal((await fetch(`${baseUrl}/admin/agent-observability?cursor=bad`, { headers: { "x-agentic-identity": "admin" } })).status, 400);
    const expired = await db.insert(agentRunsTable).values({
      id: `observability-expired-${suffix}`, agentId: prohibited.raw, agentVersion: prohibited.raw,
      actorPersonId: actor, objective: prohibited.objective, policyDecision: "DENY",
      provider: prohibited.raw, model: prohibited.raw, status: "FAILED",
      createdAt: new Date(now - 31 * 86400000),
    }).returning();
    const afterExpired = await request(baseUrl, "admin");
    assert.equal(afterExpired.body.totals.runCount, body.totals.runCount, "Older ledger rows must be excluded");
    assert(!JSON.stringify(afterExpired.body).includes(prohibited.raw));
    // Populate more than a page, including rows sharing the exact same PostgreSQL timestamp.
    const bulk = Array.from({ length: AGENT_HEALTH_PAGE_SIZE + 2 }, (_, index) => ({
      id: `observability-bulk-${suffix}-${index.toString().padStart(4, "0")}`,
      agentId: "trainer-intelligence", agentVersion: "1.0.0",
      objective: prohibited.objective, policyDecision: "ALLOW_READ",
      provider: "openrouter", model: "qwen/qwen3.8-flash", status: "PARTIAL",
      createdAt: new Date(now - 10_000),
    }));
    await db.insert(agentRunsTable).values(bulk);
    const first = await request(baseUrl, "admin");
    assert.equal(first.body.totals.runCount, AGENT_HEALTH_PAGE_SIZE);
    assert.equal(first.body.trends.reduce((sum: number, day: any) => sum + day.runCount, 0), AGENT_HEALTH_PAGE_SIZE);
    assert(first.body.nextCursor);
    assert(!first.body.nextCursor.includes(bulk[0]!.id));
    const secondResponse = await fetch(`${baseUrl}/admin/agent-observability?cursor=${encodeURIComponent(first.body.nextCursor)}`, {
      headers: { "x-agentic-identity": "admin" },
    });
    const second = await secondResponse.json() as Record<string, any>;
    assert.equal(secondResponse.status, 200);
    assert.equal(first.body.totals.runCount + second.totals.runCount, bulk.length + body.totals.runCount);
    assert.equal(second.to, first.body.to);
    assert.equal((await fetch(`${baseUrl}/admin/agent-observability?cursor=${encodeURIComponent(first.body.nextCursor)}`, {
      headers: { "x-agentic-identity": "learner" },
    })).status, 403);
    // Assert the planner's natural choice on the populated fixture, not just index eligibility.
    await pool.query("ANALYZE teras_agent_runs");
    const plan = await pool.query(`EXPLAIN SELECT id, created_at FROM teras_agent_runs
      WHERE created_at >= now() - interval '30 days' AND created_at <= now()
      ORDER BY created_at DESC, id DESC LIMIT ${AGENT_HEALTH_PAGE_SIZE + 1}`);
    assert.match(plan.rows.map(row => row["QUERY PLAN"]).join("\n"), /Index (Only )?Scan using teras_agent_runs_observability_cursor_idx/);
    assert.equal(expired.length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });