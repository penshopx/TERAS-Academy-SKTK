import assert from "node:assert/strict";
import test from "node:test";
import {
  ReadinessSummaryStatus,
  type ReadinessSummaryStatus as ReadinessStatus,
} from "@workspace/api-client-react";
import {
  getReadinessPresentation,
  readinessPresentationByStatus,
} from "./readiness-presentation";

test("defines an explicit presentation for every canonical readiness status", () => {
  const canonicalStatuses = Object.values(ReadinessSummaryStatus);

  assert.deepEqual(
    Object.keys(readinessPresentationByStatus).sort(),
    [...canonicalStatuses].sort(),
  );

  for (const status of canonicalStatuses) {
    const presentation = getReadinessPresentation(status);
    assert.equal(presentation.label, status);
    assert.ok(presentation.badgeVariant);
    assert.ok(presentation.scoreClassName);
    assert.ok(presentation.safetyState);
  }
});

test("only the canonical ready status receives ready presentation", () => {
  const expected: Record<ReadinessStatus, boolean> = {
    [ReadinessSummaryStatus.Not_Ready]: false,
    [ReadinessSummaryStatus.Developing]: false,
    [ReadinessSummaryStatus.Ready_for_Official_Assessment]: true,
  };

  assert.deepEqual(
    Object.fromEntries(
      Object.values(ReadinessSummaryStatus).map(status => [
        status,
        getReadinessPresentation(status).isReady,
      ]),
    ),
    expected,
  );
});

test("presents an unknown runtime status conservatively", () => {
  assert.deepEqual(getReadinessPresentation("Future API status"), {
    label: "Status kesiapan tidak dikenal",
    badgeVariant: "warning",
    scoreClassName: "text-amber-500",
    safetyState: "NOT CLEARED",
    isReady: false,
  });
});