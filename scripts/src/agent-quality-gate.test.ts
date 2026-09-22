import assert from "node:assert/strict";
import {
  evaluateAgentQualityGate,
  renderAgentQualityGate,
  type AgentRunSample,
} from "./agent-quality-gate.js";

const now = new Date("2025-03-20T00:00:00.000Z");
function rows(overrides: Partial<AgentRunSample> = {}, count = 100): AgentRunSample[] {
  return Array.from({ length: count }, (_, index) => ({
    agentId: "trainer-intelligence", agentVersion: "1.0.0", provider: "acme", model: "safe-v1",
    status: "COMPLETED", fallbackUsed: false, createdAt: new Date(now.getTime() - (14 * 86_400_000) + index * (14 * 86_400_000 / Math.max(1, count - 1))),
    startedAt: new Date(now.getTime() - 1_000), completedAt: now, ...overrides,
  }));
}
const production = { now, environment: "production" as const, windowFrom: new Date(now.getTime() - 30 * 86_400_000) };

{
  const result = evaluateAgentQualityGate(rows(), production);
  assert.equal(result.status, "PASS");
  assert.equal(result.sample.eligibleRuns, 100);
  assert.equal(result.p95TerminalLatencyMs, 1_000);
  assert.equal(result.distributions[0]?.runs, 100);
}
{
  assert.equal(evaluateAgentQualityGate(rows(), { ...production, environment: "development" }).status, "NOT_READY");
  assert.equal(evaluateAgentQualityGate(rows(), { ...production, windowFrom: new Date(now.getTime() - 30 * 86_400_000) }).status, "PASS");
  assert.equal(evaluateAgentQualityGate(rows({ createdAt: new Date(now.getTime() - 1_000) }), production).status, "NOT_READY");
  assert.equal(evaluateAgentQualityGate(rows({ status: "FAILED" }, 2).concat(rows()), production).sample.eligibleRuns, 102);
}
{
  assert.equal(evaluateAgentQualityGate(rows({ status: "FAILED" }, 2).concat(rows({ status: "COMPLETED" }, 98)), production).status, "FAIL");
  // Exact limits are inclusive.
  const boundary = rows({ status: "FAILED" }, 1).concat(rows({ status: "COMPLETED" }, 99));
  assert.equal(evaluateAgentQualityGate(boundary, production).status, "PASS");
  const slow = rows({ startedAt: new Date(now.getTime() - 15_000), completedAt: now });
  assert.equal(evaluateAgentQualityGate(slow, production).p95TerminalLatencyMs, 15_000);
  assert.equal(evaluateAgentQualityGate(slow, production).status, "PASS");
}
{
  const malformed = rows({ startedAt: "not-a-date", completedAt: "also-not-a-date" });
  const result = evaluateAgentQualityGate(malformed, production);
  assert.equal(result.status, "NOT_READY");
  assert.equal(result.p95TerminalLatencyMs, null);
  const json = renderAgentQualityGate(result, "json");
  const text = renderAgentQualityGate(result);
  for (const output of [json, text]) {
    for (const forbidden of ["actorPersonId", "objective", "toolRefs", "evidenceRefs", "resultHash", "resultSummary", "learner", "prompt"]) {
      assert.equal(output.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
    }
  }
  assert.match(text, /TERAS Agent Quality Gate/);
  assert.equal(JSON.parse(renderAgentQualityGate(result, "json")).canonical, true);
}
// Compile-time privacy fixture: evaluator rows have only the derived scalar.
const safeFixture: AgentRunSample = {
  agentId: "trainer-intelligence", agentVersion: "1.0.0", provider: null, model: null,
  status: "COMPLETED", fallbackUsed: false, createdAt: now, startedAt: now, completedAt: now,
};
assert.equal("resultSummary" in safeFixture, false);
console.log("agent-quality-gate tests passed");