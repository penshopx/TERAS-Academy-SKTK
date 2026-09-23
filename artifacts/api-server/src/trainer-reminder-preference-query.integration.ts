import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { db, trainerReminderPreferencesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { assertBoundedIndexPlan, explainQuery } from "./lib/explain-plan";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const indexName = "teras_trainer_reminder_preferences_trainer_created_id_idx";
const oldIndexName = "teras_trainer_reminder_preferences_trainer_created_idx";
const migrationPath = new URL("../../../lib/db/migrations/0055_trainer_reminder_preference_lookup_index.sql", import.meta.url).pathname;

async function run() {
  await client.connect();
  try {
    await client.query(`
      INSERT INTO teras_people (id, name, initials, role)
      VALUES ('preference-plan-target', 'Preference target', 'PT', 'trainer'),
             ('preference-plan-other', 'Preference other', 'PO', 'trainer');

      INSERT INTO teras_trainer_reminder_preferences (id, trainer_id, created_at)
      SELECT 'target-' || lpad(n::text, 5, '0'), 'preference-plan-target', '2026-01-01'::timestamptz
      FROM generate_series(1, 1200) n;

      INSERT INTO teras_trainer_reminder_preferences (id, trainer_id, created_at)
      SELECT 'other-' || lpad(n::text, 5, '0'), 'preference-plan-other', '2026-01-01'::timestamptz
      FROM generate_series(1, 12000) n;
    `);

    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    await observer.connect();
    try {
      // Hold a writer open until the concurrent build has registered its
      // invalid catalog entry, then cancel the build as an interrupted deploy would.
      await writer.query("BEGIN");
      await writer.query(`
        INSERT INTO teras_trainer_reminder_preferences (id, trainer_id)
        VALUES ('preference-plan-blocker', 'preference-plan-target')
      `);
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const build = client.query(`
        CREATE INDEX CONCURRENTLY ${indexName}
        ON teras_trainer_reminder_preferences (trainer_id, created_at, id)
      `);
      const cancelled = assert.rejects(build, /canceling statement due to user request/);
      let registered = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await observer.query<{ indisvalid: boolean }>(`
          SELECT idx.indisvalid FROM pg_index idx
          WHERE idx.indexrelid = to_regclass($1)
        `, [indexName]);
        if (state.rows.length && !state.rows[0]!.indisvalid) {
          registered = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(registered, "concurrent build must register an invalid index before cancellation");
      await observer.query("SELECT pg_cancel_backend($1)", [pid]);
      await cancelled;
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
      await observer.end();
    }
    const invalid = await client.query<{ indisvalid: boolean }>(`
      SELECT idx.indisvalid FROM pg_index idx
      WHERE idx.indexrelid = to_regclass($1)
    `, [indexName]);
    assert.equal(invalid.rows[0]?.indisvalid, false, "fixture must reproduce an invalid target index");

    // psql runs \gexec and each CONCURRENTLY statement outside a transaction.
    for (let replay = 0; replay < 2; replay++) {
      execFileSync("psql", [process.env.DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-f", migrationPath]);
    }
    const indexes = await client.query<{ indexname: string; indexdef: string; indisvalid: boolean; indisready: boolean }>(`
      SELECT info.indexname, info.indexdef, idx.indisvalid, idx.indisready
      FROM pg_indexes info
      JOIN pg_class relation ON relation.relname = info.indexname
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace AND namespace.nspname = info.schemaname
      JOIN pg_index idx ON idx.indexrelid = relation.oid
      WHERE info.schemaname = current_schema() AND info.tablename = 'teras_trainer_reminder_preferences'
    `);
    assert.ok(!indexes.rows.some(row => row.indexname === oldIndexName), "obsolete prefix index must be removed");
    assert.ok(
      indexes.rows.some(row => row.indexname === indexName && row.indisvalid && row.indisready),
      "replacement must be valid and ready before retiring the old index",
    );
    assert.match(
      indexes.rows.find(row => row.indexname === indexName)?.indexdef ?? "",
      /\(trainer_id, created_at, id\)/,
    );

    await client.query("ANALYZE teras_trainer_reminder_preferences");
    const query = db.select().from(trainerReminderPreferencesTable)
      .where(eq(trainerReminderPreferencesTable.trainerId, "preference-plan-target"))
      .orderBy(desc(trainerReminderPreferencesTable.createdAt), desc(trainerReminderPreferencesTable.id))
      .limit(1).toSQL();
    const result = await client.query<{ id: string }>(query.sql, query.params);
    assert.equal(result.rows[0]?.id, "target-01200", "equal timestamps must break ties by descending ID");
    const plan = await explainQuery(client, query.sql, query.params);
    assertBoundedIndexPlan(plan, { indexName, maximumRowsRead: 2 });
    assert.ok(
      !plan.some(node => /Sort/.test(node["Node Type"])),
      "active preference must not sort or incrementally sort matching revisions",
    );
  } finally {
    await client.end();
  }
}

await run();