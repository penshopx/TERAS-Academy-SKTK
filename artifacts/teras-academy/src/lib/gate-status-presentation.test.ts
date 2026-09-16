import assert from "node:assert/strict";
import test from "node:test";
import {
  GateProgressStatus,
  type GateProgressStatus as CanonicalGateStatus,
} from "@workspace/api-client-react";
import {
  gateStatusPresentationByStatus,
  getGateStatusPresentation,
} from "./gate-status-presentation";

test("defines an explicit presentation for every canonical gate status", () => {
  const canonicalStatuses = Object.values(GateProgressStatus);

  assert.deepEqual(
    Object.keys(gateStatusPresentationByStatus).sort(),
    [...canonicalStatuses].sort(),
  );

  const expectedState: Record<CanonicalGateStatus, string> = {
    [GateProgressStatus.PASSED]: "passed",
    [GateProgressStatus.ACTIVE]: "active",
    [GateProgressStatus.BLOCKED]: "blocked",
    [GateProgressStatus.LOCKED]: "locked",
  };

  for (const status of canonicalStatuses) {
    const presentation = getGateStatusPresentation(status);
    assert.equal(presentation.label, status);
    assert.equal(presentation.state, expectedState[status]);
  }
});

test("only PASSED is complete and only PASSED or ACTIVE is open", () => {
  for (const status of Object.values(GateProgressStatus)) {
    const presentation = getGateStatusPresentation(status);
    assert.equal(presentation.isPassed, status === GateProgressStatus.PASSED);
    assert.equal(
      presentation.isOpen,
      status === GateProgressStatus.PASSED || status === GateProgressStatus.ACTIVE,
    );
  }
});

test("presents unknown runtime statuses conservatively", () => {
  for (const status of ["passed", "Future API status", "", null]) {
    const presentation = getGateStatusPresentation(status);
    assert.equal(presentation.label, "UNKNOWN — LOCKED");
    assert.equal(presentation.state, "locked");
    assert.equal(presentation.isPassed, false);
    assert.equal(presentation.isCurrent, false);
    assert.equal(presentation.isBlocked, true);
    assert.equal(presentation.isOpen, false);
  }
});