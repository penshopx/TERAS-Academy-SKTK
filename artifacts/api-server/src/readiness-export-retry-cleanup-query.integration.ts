import assert from "node:assert/strict";
import { lt } from "drizzle-orm";
import pg from "pg";
import { db, readinessAuditExportAttemptsTable } from "@workspace/db";
import { assertBoundedIndexPlan, explainQuery } from "./lib/explain-plan";
import { readinessExportTrendRetentionCutoff } from "./lib/readiness-export-trend-retention";

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

    // Mirrors the retry-key deletion in pruneReadinessExportTrendAggregates,
    // including RETURNING. No enable_seqscan override: the planner must choose
    // the day index on its own with realistic active-to-expired selectivity.
    const deletion = db.delete(readinessAuditExportAttemptsTable)
      .where(lt(readinessAuditExportAttemptsTable.day, cutoffDay))
      .returning({ day: readinessAuditExportAttemptsTable.day }).toSQL();
    const plan = await explainQuery(client, deletion.sql, deletion.params);
    assertBoundedIndexPlan(plan, {
      indexName,
      // At most twice the four expired keys may be read, never the 20k active keys.
      maximumRowsRead: expiredKeyCount * 2,
    });
    assert.ok(!plan.some(node => node["Node Type"] === "Seq Scan"),
      "retry-key cleanup must not scan the full attempt table");
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