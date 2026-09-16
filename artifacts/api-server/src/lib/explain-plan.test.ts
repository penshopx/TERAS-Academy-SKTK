import assert from "node:assert/strict";
import test from "node:test";
import { assertBoundedIndexPlan, flattenExplainPlan } from "./explain-plan";

const plan = {
  "Node Type": "Limit",
  "Actual Rows": 1,
  "Actual Loops": 1,
  Plans: [{
    "Node Type": "Index Scan",
    "Index Name": "expected_idx",
    "Actual Rows": 2,
    "Actual Loops": 3,
    "Rows Removed by Filter": 1,
  }],
};

test("bounded index plans use flattened EXPLAIN JSON and count all index candidates", () => {
  const nodes = flattenExplainPlan(plan);
  assert.doesNotThrow(() => assertBoundedIndexPlan(nodes, {
    indexName: "expected_idx",
    maximumRowsRead: 9,
  }));
  assert.throws(() => assertBoundedIndexPlan(nodes, {
    indexName: "expected_idx",
    maximumRowsRead: 8,
  }), /read 9 rows, expected at most 8/);
});

test("bounded index plans reject machine-time thresholds", () => {
  assert.throws(() => assertBoundedIndexPlan(flattenExplainPlan(plan), {
    indexName: "expected_idx",
    maximumRowsRead: 9,
    maximumExecutionTimeMs: 10,
  } as Parameters<typeof assertBoundedIndexPlan>[1]), /must use rows read, not machine-time thresholds/);
});