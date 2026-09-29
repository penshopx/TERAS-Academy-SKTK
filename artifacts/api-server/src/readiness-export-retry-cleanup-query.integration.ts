import assert from "node:assert/strict";
import pg from "pg";
import { db, readinessAuditExportAttemptsTable } from "@workspace/db";
import { assertBoundedIndexPlan, explainQuery } from "./lib/explain-plan";
import { expiredReadinessExportAttemptBatchDelete, expiredReadinessExportAttemptBatchKeys, readinessExportTrendRetentionCutoff } from "./lib/readiness-export-trend-retention";

const { Client } = pg;
const indexName = "teras_readiness_audit_export_attempts_day_idx";
const activeKeyCount = 20_000;
const expiredKeyCount = 4;

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const cutoffDay = readinessExportTrendRetentionCutoff(new Date());
    // The isolated database starts empty. Most retry keys are inside retention;
    // only a tiny fraction qualify for the production DELETE predicate.
    await client.query(`
      INSERT INTO teras_readiness_audit_export_attempts (attempt_key, day)
      SELECT 'retry-plan-active-' || n, $1::date + (n % 90)
      FROM generate_series(1, $2::integer) AS n
    `, [cutoffDay, activeKeyCount]);
    await client.query(`
      INSERT INTO teras_readiness_audit_export_attempts (attempt_key, day)
      SELECT 'retry-plan-expired-' || n, $1::date - n
      FROM generate_series(1, $2::integer) AS n
    `, [cutoffDay, expiredKeyCount]);
    await client.query("ANALYZE teras_readiness_audit_export_attempts");
    const fixture = await client.query<{ total: number; expired: number }>(`
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE day < $1::date)::integer AS expired
      FROM teras_readiness_audit_export_attempts
    `, [cutoffDay]);
    assert.deepEqual(fixture.rows[0], {
      total: activeKeyCount + expiredKeyCount,
      expired: expiredKeyCount,
    }, "plan fixture must be dominated by active keys with only four expired keys");

    // Mirror both statements in one batch. Selection must use the day index;
    // deletion must use the selected primary keys, never scan active keys.
    const selection = expiredReadinessExportAttemptBatchKeys(db, cutoffDay).toSQL();
    const plan = await explainQuery(client, selection.sql, selection.params);
    assertBoundedIndexPlan(plan, {
      indexName,
      // At most twice the four expired keys may be read, never the 20k active keys.
      maximumRowsRead: expiredKeyCount * 2,
    });
    assert.ok(!plan.some(node => node["Node Type"] === "Seq Scan"),
      "retry-key selection must not scan the full attempt table");
    const keys = (await client.query<{ attempt_key: string }>(selection.sql, selection.params))
      .rows.map(row => row.attempt_key);
    const deletion = expiredReadinessExportAttemptBatchDelete(db, cutoffDay, keys).toSQL();
    const deletePlan = await explainQuery(client, deletion.sql, deletion.params);
    assert.ok(!deletePlan.some(node => node["Node Type"] === "Seq Scan"),
      "retry-key deletion must not scan the full attempt table");
    const remaining = await client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM teras_readiness_audit_export_attempts",
    );
    assert.equal(remaining.rows[0]?.count, activeKeyCount,
      "the measured DELETE must remove expired retry keys and preserve active ones");
  } finally {
    await client.end();
  }
}

await run();