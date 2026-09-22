import assert from "node:assert/strict";
import test from "node:test";
import { readinessGateStatus, type ReadinessGateStatus } from "./teras";

const passed = (status: ReadinessGateStatus) => status === "PASSED";

test("readiness gates expose every canonical status", () => {
  assert.equal(readinessGateStatus({
    previousPassed: true,
    hasPolicyBlockers: false,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  }), "PASSED");

  assert.equal(readinessGateStatus({
    previousPassed: true,
    hasPolicyBlockers: true,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  }), "ACTIVE");

  assert.equal(readinessGateStatus({
    previousPassed: true,
    hasPolicyBlockers: true,
    hardGateFailed: true,
    hasSafetyBlockers: false,
  }), "BLOCKED");

  assert.equal(readinessGateStatus({
    previousPassed: false,
    hasPolicyBlockers: false,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  }), "LOCKED");
});

test("a safety blocker is non-compensable and produces BLOCKED", () => {
  assert.equal(readinessGateStatus({
    previousPassed: true,
    hasPolicyBlockers: false,
    hardGateFailed: false,
    hasSafetyBlockers: true,
  }), "BLOCKED");
});

test("the next gate stays LOCKED until its prerequisite passes", () => {
  const firstGateStatus = readinessGateStatus({
    previousPassed: true,
    hasPolicyBlockers: true,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  });
  assert.equal(firstGateStatus, "ACTIVE");
  assert.equal(readinessGateStatus({
    previousPassed: passed(firstGateStatus),
    hasPolicyBlockers: false,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  }), "LOCKED");

  const clearedFirstGateStatus = readinessGateStatus({
    previousPassed: true,
    hasPolicyBlockers: false,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  });
  assert.equal(clearedFirstGateStatus, "PASSED");
  assert.equal(readinessGateStatus({
    previousPassed: passed(clearedFirstGateStatus),
    hasPolicyBlockers: false,
    hardGateFailed: false,
    hasSafetyBlockers: false,
  }), "PASSED");
});