import assert from "node:assert/strict";
import test from "node:test";
import {
  EvidenceEnvelope, TRAINER_INTELLIGENCE_AGENT, policyFor,
  sanitizeEvidenceEnvelope, validateProviderSelection,
} from "./agentic";

const fallback = EvidenceEnvelope.parse({
  claims: [{ claim: "A grounded claim.", evidenceRefs: ["assignment:l1:p1"], confidence: "high", grounding: "grounded" }],
  limitations: ["Advisory only."],
  recommendedActions: [{ action: "Review the linked record.", evidenceRefs: ["assignment:l1:p1"] }],
  sourceRefs: ["assignment:l1:p1"],
  asOf: new Date().toISOString(),
  advisoryNotice: "Advisory only. This analysis does not determine competency, certification, readiness, or official assessment outcomes.",
});

test("keeps the trainer agent read/propose only", () => {
    assert.equal(TRAINER_INTELLIGENCE_AGENT.maxPermission, "PROPOSE");
    assert.equal(TRAINER_INTELLIGENCE_AGENT.execution, "NONE");
    assert.equal(policyFor(TRAINER_INTELLIGENCE_AGENT.id, "READ"), "ALLOW_READ");
    assert.equal(policyFor("unknown-agent", "READ"), "DENY");
  });

test("falls back when untrusted output is not structured", () => {
    assert.deepEqual(sanitizeEvidenceEnvelope({ claims: "not an array" }, fallback), fallback);
  });

test("removes forbidden official claims from otherwise valid output", () => {
    const unsafe = { ...fallback, claims: [{ claim: "You are officially certified.", evidenceRefs: [], confidence: "high", grounding: "grounded" }] };
    assert.equal(sanitizeEvidenceEnvelope(unsafe, fallback).claims.length, 0);
  });

test("rejects unknown, duplicate, cross-scope, and malformed provider selections", () => {
  const expected = ["fact-1", "fact-2"];
  const valid = { factCodes: ["fact-2", "fact-1"] };
  assert(validateProviderSelection(valid, expected));
  for (const invalid of [
    { ...valid, factCodes: ["fact-1", "fact-1"] },
    { ...valid, factCodes: ["fact-1", "fact-9"] },
    { ...valid, factCodes: ["fact-1"] },
    { ...valid, factCodes: ["fact-1", "fact-2"], text: "injected source text" },
    { ...valid, asOf: "2099-01-01T00:00:00.000Z" },
  ]) assert.equal(validateProviderSelection(invalid, expected), null);
});