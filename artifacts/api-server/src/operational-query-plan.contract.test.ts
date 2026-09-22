import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const requiredOperationalSuites = [
  "./capability-timeline-query.integration.ts",
  "./admin-operational-summary-query.integration.ts",
  "./trainer-review-queue.integration.ts",
] as const;

const helperImportPattern =
  /import\s*\{(?=[^}]*\bexplainQuery\b)(?=[^}]*\bassert(?:BoundedIndexPlan|SinglePassScanPlan)\b)[^}]*\}\s*from\s*["']\.\/lib\/explain-plan["']/s;
const localExplainParserPatterns = [
  /EXPLAIN\s*\(\s*ANALYZE[^)]*FORMAT\s+JSON/i,
  /\[\s*["']QUERY PLAN["']\s*\]/,
  /function\s+\w*(?:flatten|parse)\w*Explain\w*\s*\(/i,
];
const machineTimeThresholdPattern =
  /\b(?:maximum|max|expected|allowed)?(?:Execution|Planning)?(?:Time|Duration|Elapsed)(?:Ms|Millis|Milliseconds)?\b/i;

export function assertUsesSharedRowBasedExplainHelper(fileName: string, source: string) {
  assert.match(
    source,
    helperImportPattern,
    `${fileName} must import explainQuery and row-based plan assertions from ./lib/explain-plan`,
  );

  for (const pattern of localExplainParserPatterns) {
    assert.doesNotMatch(
      source,
      pattern,
      `${fileName} must not parse EXPLAIN JSON locally; use explainQuery from ./lib/explain-plan`,
    );
  }

  assert.doesNotMatch(
    source,
    machineTimeThresholdPattern,
    `${fileName} must use row-based assertions from ./lib/explain-plan, not machine-time thresholds`,
  );
}

test("operational query suites share row-based EXPLAIN plan rules", () => {
  const sourceDirectory = new URL(".", import.meta.url);
  const discoveredSuites = readdirSync(sourceDirectory)
    .filter(fileName => fileName.endsWith("-query.integration.ts"))
    .map(fileName => `./${fileName}`);
  const operationalSuites = new Set([...requiredOperationalSuites, ...discoveredSuites]);

  for (const fileName of operationalSuites) {
    const source = readFileSync(new URL(fileName, import.meta.url), "utf8");
    assertUsesSharedRowBasedExplainHelper(fileName, source);
  }
});

test("contract rejects local EXPLAIN JSON parsers with actionable guidance", () => {
  const localParser = `
    import { explainQuery, assertBoundedIndexPlan } from "./lib/explain-plan";
    const result = await client.query("EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1");
    const plan = result.rows[0]["QUERY PLAN"];
  `;

  assert.throws(
    () => assertUsesSharedRowBasedExplainHelper("new-operational-query.integration.ts", localParser),
    /must not parse EXPLAIN JSON locally; use explainQuery from \.\/lib\/explain-plan/,
  );
});

test("contract rejects machine-time thresholds with row-based guidance", () => {
  const timedCheck = `
    import { explainQuery, assertBoundedIndexPlan } from "./lib/explain-plan";
    const maximumExecutionTimeMs = 50;
  `;

  assert.throws(
    () => assertUsesSharedRowBasedExplainHelper("new-operational-query.integration.ts", timedCheck),
    /must use row-based assertions from \.\/lib\/explain-plan, not machine-time thresholds/,
  );
});