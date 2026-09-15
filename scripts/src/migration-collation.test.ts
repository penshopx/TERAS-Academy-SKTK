import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import {
  findUnsafeTextWinnerOrdering,
  type SqlType,
} from "./migration-collation-policy.js";

const authoritativeTypes = new Map<string, SqlType>();
for (const candidate of Object.values(schema)) {
  try {
    const table = getTableName(candidate as Parameters<typeof getTableName>[0]);
    const columns = getTableColumns(candidate as Parameters<typeof getTableColumns>[0]);
    for (const column of Object.values(columns)) {
      const columnType = column.columnType.toLowerCase();
      const type: SqlType =
        columnType.includes("text") || columnType.includes("varchar") || columnType.includes("char")
          ? "text"
          : columnType.includes("uuid")
            ? "uuid"
            : column.dataType === "number" || column.dataType === "bigint"
              ? "numeric"
              : column.dataType === "date"
                ? "timestamp"
                : column.dataType === "json"
                  ? "json"
                  : "other";
      authoritativeTypes.set(`${table}.${column.name}`, type);
      const previous = authoritativeTypes.get(column.name);
      if (!previous || previous === type) authoritativeTypes.set(column.name, type);
      else authoritativeTypes.set(column.name, "other");
    }
  } catch {
    // Schema modules also export relations and validation objects; only tables are relevant.
  }
}
assert.equal(authoritativeTypes.get("teras_people.id"), "text");
assert.equal(authoritativeTypes.get("teras_modules.pathway_id"), "text");

const diagnosticMigration = await readFile(
  new URL("../../lib/db/migrations/0020_diagnostic_single_active_session.sql", import.meta.url),
  "utf8",
);
const eventContextMigration = await readFile(
  new URL("../../lib/db/migrations/0033_enrollment_event_context.sql", import.meta.url),
  "utf8",
);
const resourceProgressMigration = await readFile(
  new URL("../../lib/db/migrations/0038_learning_resource_progress_context.sql", import.meta.url),
  "utf8",
);

const diagnosticTieBreakers = diagnosticMigration.match(
  /ORDER BY session\.progress DESC, session\.created_at ASC, session\.id COLLATE "C" ASC/g,
);
assert.equal(
  diagnosticTieBreakers?.length,
  2,
  "canonical diagnostic session ranking must use the same bytewise ID tie-breaker",
);
assert.doesNotMatch(
  diagnosticMigration,
  /ORDER BY session\.progress DESC, session\.created_at ASC, session\.id (?:ASC|DESC)/,
);

const eventPathwayTieBreakers = eventContextMigration.match(
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id COLLATE "C" DESC/g,
);
assert.equal(
  eventPathwayTieBreakers?.length,
  6,
  "every historical pathway winner in the event-context migration must use bytewise ID order",
);
assert.doesNotMatch(
  eventContextMigration,
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id (?:ASC|DESC)/,
);

assert.match(
  resourceProgressMigration,
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id COLLATE "C" DESC/,
);
assert.doesNotMatch(
  resourceProgressMigration,
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id (?:ASC|DESC)/,
);

const unsafeFixture = `
  CREATE TABLE candidates (
    id text,
    score integer,
    recorded_at timestamp with time zone,
    external_id uuid,
    payload jsonb
  );
  SELECT * FROM candidates ORDER BY score DESC, id ASC LIMIT 1;
  SELECT row_number() OVER (ORDER BY recorded_at, id DESC) FROM candidates;
  SELECT DISTINCT ON (id) id FROM candidates ORDER BY id;
  SELECT max(id) FROM candidates;
`;
assert.equal(
  findUnsafeTextWinnerOrdering(unsafeFixture).length,
  4,
  "winner ordering, ranking, DISTINCT ON, and text extrema must reject implicit text collation",
);

const safeFixture = `
  CREATE TABLE candidates (
    id text,
    score numeric,
    recorded_at timestamp with time zone,
    external_id uuid,
    payload jsonb
  );
  SELECT * FROM candidates ORDER BY id;
  SELECT jsonb_agg(payload ORDER BY id) FROM candidates;
  SELECT * FROM candidates ORDER BY score DESC, recorded_at, external_id LIMIT 1;
  SELECT row_number() OVER (ORDER BY id COLLATE "C") FROM candidates;
  SELECT DISTINCT ON (id COLLATE "C") id FROM candidates ORDER BY id COLLATE "C";
  SELECT max(id COLLATE "C") FROM candidates;
`;
assert.deepEqual(
  findUnsafeTextWinnerOrdering(safeFixture),
  [],
  "display/JSON ordering and timestamp, numeric, UUID, or explicitly collated winners are safe",
);

const distinctWinnerFixture = `
  CREATE TABLE candidates (group_id uuid, id text);
  SELECT DISTINCT ON (group_id) id
  FROM candidates
  ORDER BY group_id, id;
`;
assert.equal(
  findUnsafeTextWinnerOrdering(distinctWinnerFixture).length,
  1,
  "DISTINCT ON must validate the text tie-breaker in its winner ORDER BY",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(
    distinctWinnerFixture.replace("group_id, id;", 'group_id, id COLLATE "C";'),
  ),
  [],
  "DISTINCT ON accepts an explicitly collated text tie-breaker",
);
const projectedAliasFindings = findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (group_id uuid, id text);
    SELECT lower(id) AS winner FROM candidates ORDER BY winner LIMIT 1;
    SELECT DISTINCT ON (group_id) lower(id) AS winner
    FROM candidates ORDER BY group_id, winner;
  `);
assert.equal(
  projectedAliasFindings.length,
  2,
  "text-producing projected aliases must retain their type in winner ordering",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT lower(id COLLATE "C") AS winner
    FROM candidates ORDER BY winner FETCH FIRST 1 ROW ONLY;
  `),
  [],
  "a projected expression with bytewise collation remains safe through its alias",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id FROM candidates ORDER BY id COLLATE "en_US" LIMIT 1;
  `).length,
  1,
  "locale-dependent explicit collations are not accepted as bytewise ordering",
);
const alternateExpressionFindings = findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text, score integer, payload jsonb);
    SELECT lower(id) AS winner FROM candidates ORDER BY winner FETCH FIRST ROW ONLY;
    SELECT id AS winner FROM candidates ORDER BY (winner) LIMIT 1;
    SELECT substring(id FROM 1) AS winner FROM candidates ORDER BY winner LIMIT 1;
  `);
assert.equal(
  alternateExpressionFindings.length,
  3,
  "omitted FETCH counts, parenthesized aliases, and additional text functions are rejected",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id winner FROM candidates ORDER BY winner LIMIT 01;
    SELECT id winner FROM candidates ORDER BY winner LIMIT (1::integer);
    SELECT id winner FROM candidates ORDER BY winner LIMIT CAST(1 AS integer);
  `).length,
  3,
  "implicit aliases and equivalent one-row LIMIT expressions are rejected",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text, score integer, payload jsonb);
    SELECT id FROM candidates ORDER BY id LIMIT 10;
    SELECT length(id) AS size FROM candidates ORDER BY size LIMIT 1;
    SELECT jsonb_array_length(payload) AS size FROM candidates ORDER BY size LIMIT 1;
  `),
  [],
  "numeric and JSON-producing functions are not treated as text winners",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id FROM candidates ORDER BY 1 LIMIT 1;
    SELECT id FROM candidates ORDER BY 1 NULLS LAST LIMIT 1;
    SELECT id FROM candidates ORDER BY 1 DESC NULLS FIRST LIMIT 1;
    SELECT id FROM candidates ORDER BY id OFFSET 0 FETCH FIRST 1 ROW ONLY;
  `).length,
  4,
  "positional/null ordering and OFFSET/FETCH resolve to the projected text expression",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id FROM candidates ORDER BY id NULLS LAST LIMIT 1;
    SELECT DISTINCT id FROM candidates ORDER BY 1 LIMIT 1;
    SELECT id FROM candidates ORDER BY id USING > LIMIT 1;
  `).length,
  3,
  "standalone NULLS, ordinary DISTINCT positions, and USING operators retain text typing",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id FROM candidates ORDER BY id COLLATE "C" NULLS LAST LIMIT 1;
    SELECT DISTINCT id COLLATE "C" FROM candidates ORDER BY 1 LIMIT 1;
    SELECT id FROM candidates ORDER BY id COLLATE "C" USING > LIMIT 1;
  `),
  [],
  "bytewise collation remains safe with NULLS, DISTINCT positions, and USING",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (payload jsonb, score integer);
    SELECT payload FROM candidates ORDER BY payload->>'priority' LIMIT 1;
    SELECT score FROM candidates
    ORDER BY CASE WHEN score = 1 THEN 'Z' ELSE 'a' END LIMIT 1;
  `).length,
  2,
  "JSON text extraction and literal-valued CASE expressions require bytewise collation",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (payload jsonb, score integer);
    SELECT payload FROM candidates ORDER BY (payload->>'priority') COLLATE "C" LIMIT 1;
    SELECT score FROM candidates
    ORDER BY (CASE WHEN score = 1 THEN 'Z' ELSE 'a' END) COLLATE "C" LIMIT 1;
  `),
  [],
  "JSON text extraction and literal CASE expressions accept bytewise collation",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text, score integer);
    WITH ordered AS (
      SELECT id FROM candidates ORDER BY id
    )
    SELECT id FROM ordered ORDER BY id LIMIT 1;
    SELECT derived.id
    FROM (SELECT id FROM candidates ORDER BY id) derived
    ORDER BY derived.id LIMIT 1;
    SELECT id, array_agg(id ORDER BY id)
    FROM candidates GROUP BY id ORDER BY id LIMIT 1;
    SELECT score FROM candidates
    ORDER BY CASE WHEN score = 1 THEN E'Z' ELSE E'a' END LIMIT 1;
  `).length,
  4,
  "winner ordering is paired by query depth and E-prefixed text literals are recognized",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE text_candidates (group_id uuid, id text);
    CREATE TABLE numeric_candidates (id bigint);
    SELECT DISTINCT ON (group_id) derived.id
    FROM (SELECT 1 AS position FROM numeric_candidates ORDER BY position) derived,
         text_candidates
    ORDER BY group_id, text_candidates.id;
    WITH text_rank AS (
      SELECT row_number() OVER (ORDER BY reused.id) FROM text_candidates reused
    ), numeric_rank AS (
      SELECT row_number() OVER (ORDER BY reused.id) FROM numeric_candidates reused
    )
    SELECT 1;
  `).length,
  2,
  "DISTINCT ordering and reused aliases are isolated to their own query scopes",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE text_candidates (id text);
    CREATE TABLE numeric_candidates (id bigint);
    WITH unused_numeric AS (
      SELECT id FROM numeric_candidates
    ), chosen_text AS (
      SELECT id FROM text_candidates
    )
    SELECT id FROM chosen_text ORDER BY id LIMIT 1;
    WITH chosen_numeric AS (
      SELECT id FROM numeric_candidates
    )
    SELECT id FROM chosen_numeric ORDER BY id LIMIT 1;
  `).length,
  1,
  "unrelated CTE column types do not contaminate text or numeric winners",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE text_candidates (id text);
    CREATE TABLE numeric_candidates (id bigint);
    WITH chosen_text AS (
      SELECT id FROM text_candidates
      UNION ALL
      SELECT NULL
    )
    SELECT id FROM chosen_text ORDER BY id LIMIT 1;
    WITH chosen_numeric AS (
      SELECT id FROM numeric_candidates
      UNION ALL
      SELECT NULL
    )
    SELECT id FROM chosen_numeric ORDER BY id LIMIT 1;
  `).length,
  1,
  "set-operation CTEs preserve text winners and suppress numeric name collisions",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE text_candidates (id text);
    WITH RECURSIVE chosen(winner) AS MATERIALIZED (
      SELECT id FROM text_candidates
      UNION ALL
      SELECT NULL
    )
    SELECT winner FROM chosen ORDER BY winner LIMIT 1;
    WITH chosen(winner) AS NOT MATERIALIZED (
      SELECT id FROM text_candidates
    )
    SELECT winner FROM chosen ORDER BY winner LIMIT 1;
  `).length,
  2,
  "recursive and materialized CTE forms preserve text output typing",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text, score integer);
    -- CREATE TABLE candidates (id integer);
    SELECT id FROM candidates ORDER BY id LIMIT 1;
    SELECT score FROM candidates
    ORDER BY CASE
      WHEN id COLLATE "C" = 'fixed' THEN 'Z'
      ELSE 'a'
    END LIMIT 1;
  `).length,
  2,
  "commented schema cannot override types and nested predicate collation does not collate CASE output",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text, score integer);
    SELECT score FROM candidates
    ORDER BY (CASE WHEN score = 1 THEN 'Z' ELSE 'a' END) COLLATE "C" LIMIT 1;
  `),
  [],
  "bytewise collation applied to the result expression is safe",
);
const ddlExpressionFindings = findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id integer);
    ALTER TABLE candidates ALTER COLUMN id TYPE text;
    SELECT id FROM candidates ORDER BY id LIMIT 1;
    CREATE TEMP TABLE temp_candidates (id text);
    SELECT id FROM temp_candidates ORDER BY id LIMIT 1;
    SELECT value FROM (VALUES ('Z'), ('a')) AS values_text(value)
    ORDER BY value LIMIT 1;
    SELECT id FROM candidates ORDER BY ROW(id, 1) LIMIT 1;
    SELECT id FROM candidates ORDER BY ARRAY[id] LIMIT 1;
  `);
assert.equal(
  ddlExpressionFindings.length,
  5,
  "altered/temp schemas, VALUES, row, and array text winners are rejected",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE source (id text);
    CREATE TEMP TABLE copied AS SELECT id FROM source;
    SELECT id FROM copied ORDER BY id COLLATE "C" LIMIT 1;
    SELECT value FROM (VALUES (1), (2)) AS values_numeric(value)
    ORDER BY value LIMIT 1;
  `),
  [],
  "CTAS text with bytewise ordering and numeric VALUES remain safe",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (score integer);
    ALTER TABLE candidates
      ADD sequence integer,
      ADD winner text;
    SELECT winner FROM candidates ORDER BY winner LIMIT 1;
    SELECT row_number() OVER chosen FROM candidates
    WINDOW chosen AS (ORDER BY winner);
    SELECT row_number() OVER (chosen) FROM candidates
    WINDOW chosen AS (ORDER BY winner);
  `).length,
  3,
  "compound ALTER actions and named ranking windows preserve text typing",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (winner text);
    SELECT row_number() OVER chosen FROM candidates
    WINDOW chosen AS (ORDER BY winner COLLATE "C");
  `),
  [],
  "named ranking windows accept bytewise text ordering",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (winner text);
    SELECT first_value(winner) OVER (ORDER BY winner) FROM candidates;
    SELECT last_value(winner) OVER (ORDER BY winner) FROM candidates;
    SELECT nth_value(winner, 2) OVER (ORDER BY winner) FROM candidates;
    SELECT first_value(coalesce(winner, 'x')) OVER (ORDER BY winner)
    FROM candidates;
    SELECT row_number() OVER child FROM candidates
    WINDOW base AS (ORDER BY winner), child AS (base);
    SELECT row_number() OVER (base ROWS UNBOUNDED PRECEDING) FROM candidates
    WINDOW base AS (ORDER BY winner);
  `).length,
  6,
  "value windows and recursively inherited named windows reject text ordering",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (winner text);
    SELECT first_value(winner) OVER child FROM candidates
    WINDOW base AS (ORDER BY winner COLLATE "C"), child AS (base);
  `),
  [],
  "recursively inherited bytewise named windows remain safe",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT row_number() OVER (ORDER BY trim(BOTH FROM id)) FROM candidates;
    SELECT row_number() OVER (
      ORDER BY (SELECT nested.id FROM candidates nested LIMIT 1)
    ) FROM candidates;
    SELECT row_number() OVER "child window" FROM candidates
    WINDOW "base window" AS (ORDER BY id),
           "child window" AS ("base window");
  `).length,
  3,
  "TRIM operands, scalar subqueries, and quoted window inheritance preserve text ordering",
);
assert.equal(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text, score integer);
    SELECT id FROM candidates ORDER BY CAST(id AS varchar(255)) LIMIT 1;
    SELECT id FROM candidates
    ORDER BY coalesce(CAST(id AS character varying ( 255 )), 'x') LIMIT 1;
    SELECT id FROM candidates
    ORDER BY CASE WHEN score = 1 THEN CAST(id AS char(8)) ELSE 'x' END LIMIT 1;
  `).length,
  3,
  "parameterized text casts remain collation-dependent through nested expressions",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id FROM candidates
    ORDER BY CAST(id AS varchar(255)) COLLATE "C" LIMIT 1;
  `),
  [],
  "parameterized text casts are safe when the result is bytewise collated",
);
assert.deepEqual(
  findUnsafeTextWinnerOrdering(`
    CREATE TABLE candidates (id text);
    SELECT id COLLATE "C" FROM candidates ORDER BY 1 LIMIT 1;
    SELECT $$SELECT id FROM candidates ORDER BY id LIMIT 1$$;
  `),
  [],
  "bytewise positional ordering is safe and dollar-quoted data is not executable SQL",
);

const statementIsolationFixture = `
  CREATE TABLE text_candidates (id text);
  CREATE TABLE numeric_candidates (id bigint);
  SELECT id FROM text_candidates ORDER BY id;
  SELECT id FROM text_candidates ORDER BY id LIMIT 1;
  SELECT row_number() OVER (ORDER BY reused.id) FROM text_candidates reused;
  SELECT row_number() OVER (ORDER BY reused.id) FROM numeric_candidates reused;
`;
assert.equal(
  findUnsafeTextWinnerOrdering(statementIsolationFixture).length,
  2,
  "display ordering must not mask a later winner and aliases must be statement-local",
);

const dollarQuotedFixture = `
  CREATE TABLE candidates (id text);
  CREATE FUNCTION choose_candidate() RETURNS text AS $body$
  BEGIN
    PERFORM id FROM candidates ORDER BY id;
    RETURN (SELECT id FROM candidates ORDER BY id LIMIT 1);
  END;
  $body$ LANGUAGE plpgsql;
`;
assert.equal(
  findUnsafeTextWinnerOrdering(dollarQuotedFixture).length,
  1,
  "PL/pgSQL statements inside dollar-quoted bodies must be analyzed independently",
);

const projectSchemaFixture = `
  SELECT id FROM teras_people ORDER BY id LIMIT 1;
  SELECT row_number() OVER (ORDER BY module.pathway_id)
  FROM teras_modules module;
  SELECT lower(id) FROM teras_people ORDER BY lower(id) LIMIT 1;
  SELECT id::text FROM teras_people ORDER BY id::text LIMIT 1;
  SELECT coalesce(id, name) FROM teras_people ORDER BY coalesce(id, name) LIMIT 1;
  SELECT row_number() OVER (ORDER BY lower(id), coalesce(name, id))
  FROM teras_people;
  SELECT max(lower(id)) FROM teras_people;
  WITH ranked AS (
    SELECT person.id AS winner_id FROM teras_people person
  )
  SELECT winner_id FROM ranked ORDER BY winner_id LIMIT (1);
  SELECT derived.id
  FROM (SELECT person.id FROM teras_people person) derived
  ORDER BY derived.id FETCH FIRST 1 ROW ONLY;
  WITH ranked AS (SELECT id FROM teras_people)
  SELECT ranked.id FROM ranked ORDER BY ranked.id FETCH NEXT 1 ROW ONLY;
  SELECT id FROM teras_people
  ORDER BY CASE WHEN status = 'active' THEN name ELSE id END LIMIT 1;
  SELECT id FROM teras_people ORDER BY name || id LIMIT 1;
`;
const projectSchemaFindings = findUnsafeTextWinnerOrdering(
    projectSchemaFixture,
    projectSchemaFixture,
    authoritativeTypes,
  );
assert.equal(
  projectSchemaFindings.length,
  13,
  "real project text columns and common text-producing expressions must be rejected",
);

const migrationsDirectory = new URL("../../lib/db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();
const auditedBaseline = "0045_legacy_module_single_baseline.sql";
const newMigrationFindings: string[] = [];
let schemaContext = "";

for (const file of migrationFiles) {
  const sql = await readFile(new URL(file, migrationsDirectory), "utf8");
  schemaContext += `\n${sql}`;
  if (file > auditedBaseline) {
    for (const finding of findUnsafeTextWinnerOrdering(
      sql,
      schemaContext,
      authoritativeTypes,
    )) {
      newMigrationFindings.push(
        `${file}:${finding.line}: ${finding.reason}: ${finding.expression}`,
      );
    }
  }
}

assert.deepEqual(
  newMigrationFindings,
  [],
  `new migrations contain collation-dependent text winner selection:\n${newMigrationFindings.join("\n")}`,
);

console.log("Migration text winner collation contracts passed");