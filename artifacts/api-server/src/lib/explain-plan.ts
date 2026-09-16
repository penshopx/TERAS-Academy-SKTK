import assert from "node:assert/strict";

export type ExplainPlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: ExplainPlanNode[];
};

type QueryClient = {
  query<T>(query: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

type BoundedIndexExpectation = {
  indexName: string;
  maximumRowsRead: number;
};

export function flattenExplainPlan(node: ExplainPlanNode): ExplainPlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenExplainPlan)];
}

export async function explainQuery(
  client: QueryClient,
  query: string,
  values: unknown[] = [],
) {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
    `EXPLAIN (ANALYZE, FORMAT JSON, TIMING FALSE, SUMMARY FALSE) ${query}`,
    values,
  );
  const plan = result.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  assert.ok(plan, "EXPLAIN JSON did not contain a root Plan node");
  return flattenExplainPlan(plan);
}

export function rowsRead(node: ExplainPlanNode) {
  return (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"];
}

export function assertBoundedIndexPlan(
  nodes: ExplainPlanNode[],
  expectation: BoundedIndexExpectation,
) {
  const unsupportedThreshold = Object.keys(expectation).find(key => /time|duration/i.test(key));
  assert.equal(
    unsupportedThreshold,
    undefined,
    "EXPLAIN plan checks must use rows read, not machine-time thresholds",
  );
  assert.ok(
    Number.isFinite(expectation.maximumRowsRead) && expectation.maximumRowsRead >= 0,
    `maximumRowsRead must be a non-negative finite number, received ${expectation.maximumRowsRead}`,
  );
  const scan = nodes.find(node => node["Index Name"] === expectation.indexName);
  assert.ok(
    scan,
    `expected query plan to use ${expectation.indexName}; plan nodes: ${nodes.map(node => `${node["Node Type"]}:${node["Index Name"] ?? "-"}`).join(", ")}`,
  );
  const actualRowsRead = rowsRead(scan);
  assert.ok(
    actualRowsRead <= expectation.maximumRowsRead,
    `${expectation.indexName} read ${actualRowsRead} rows, expected at most ${expectation.maximumRowsRead}`,
  );
}

export function assertSinglePassScanPlan(
  nodes: ExplainPlanNode[],
  maximumRowsRead: number,
) {
  const scans = nodes.filter(node => node["Node Type"].includes("Scan"));
  const actualRowsRead = scans.reduce((total, scan) => total + rowsRead(scan), 0);
  assert.ok(
    actualRowsRead <= maximumRowsRead,
    `count query read ${actualRowsRead} rows, expected a single pass of at most ${maximumRowsRead}`,
  );
  assert.ok(scans.every(scan => scan["Actual Loops"] === 1), "count query must not execute correlated scan loops");
}