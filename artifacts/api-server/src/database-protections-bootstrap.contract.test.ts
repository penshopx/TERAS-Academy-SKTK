import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationsDirectory = resolve(repositoryRoot, "lib/db/migrations");
const bootstrapPath = resolve(repositoryRoot, "scripts/bootstrap-database-protections.sh");
const postMergePath = resolve(repositoryRoot, "scripts/post-merge.sh");

function persistentFunctionOrTriggerMigration(fileName: string) {
  const sql = readFileSync(resolve(migrationsDirectory, fileName), "utf8");
  const createsFunction = /CREATE(?: OR REPLACE)? FUNCTION\s+/i.test(sql);
  const createsTrigger = /CREATE(?: CONSTRAINT)? TRIGGER\s+/i.test(sql);
  const dropsCreatedFunction =
    createsFunction && /DROP FUNCTION IF EXISTS\s+teras_is_valid_resource_uri/i.test(sql);
  return (createsFunction || createsTrigger) && !dropsCreatedFunction;
}

test("bootstrap inventory includes every persistent non-Drizzle function or trigger migration", () => {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const inventoried = [...bootstrap.matchAll(/"lib\/db\/migrations\/([^"]+\.sql)"/g)]
    .map(match => basename(match[1]!))
    .sort();
  const discovered = readdirSync(migrationsDirectory)
    .filter(fileName => fileName.endsWith(".sql"))
    .filter(persistentFunctionOrTriggerMigration)
    .sort();

  assert.deepEqual(inventoried, discovered);
});

test("post-merge invokes the canonical database protection bootstrap", () => {
  const postMerge = readFileSync(postMergePath, "utf8");
  assert.match(
    postMerge,
    /^bash scripts\/bootstrap-database-protections\.sh$/m,
    "removing the post-push protection bootstrap must fail this contract",
  );
});

test("bootstrap stops before psql when schema push fails", () => {
  const fixtureDirectory = mkdtempSync(resolve(tmpdir(), "database-protection-push-failure-"));
  const binDirectory = resolve(fixtureDirectory, "bin");
  const invocationLog = resolve(fixtureDirectory, "psql-invocations.log");

  try {
    mkdirSync(binDirectory);

    const fakePnpm = resolve(binDirectory, "pnpm");
    writeFileSync(
      fakePnpm,
      "#!/bin/bash\nprintf '%s\\n' 'schema push fixture failed' >&2\nexit 27\n",
    );
    chmodSync(fakePnpm, 0o755);

    const fakePsql = resolve(binDirectory, "psql");
    writeFileSync(fakePsql, "#!/bin/bash\nprintf '%s\\n' called >> \"$PSQL_INVOCATION_LOG\"\n");
    chmodSync(fakePsql, 0o755);

    const result = spawnSync("bash", [bootstrapPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://unused-by-fake-psql",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        PSQL_INVOCATION_LOG: invocationLog,
      },
    });

    assert.equal(result.error, undefined, "bootstrap process must start");
    assert.notEqual(result.status, 0, "failed schema push must make bootstrap exit non-zero");
    assert.match(result.stderr, /schema push fixture failed/, "operator must see the push error");
    assert.match(
      result.stderr,
      /Database schema push failed before protection migrations\./,
      "operator must see why protection migrations did not run",
    );
    assert.equal(existsSync(invocationLog), false, "psql must never be invoked");
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("bootstrap reports a real psql failure and stops before later migrations", () => {
  const fixtureDirectory = mkdtempSync(resolve(tmpdir(), "database-protection-bootstrap-"));
  const binDirectory = resolve(fixtureDirectory, "bin");
  const migrationLog = resolve(fixtureDirectory, "psql-migrations.log");

  try {
    mkdirSync(binDirectory);

    const fakePnpm = resolve(binDirectory, "pnpm");
    writeFileSync(fakePnpm, "#!/bin/bash\nexit 0\n");
    chmodSync(fakePnpm, 0o755);

    const fakePsql = resolve(binDirectory, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/bash
set -euo pipefail
while (($#)); do
  if [[ "$1" == "-f" ]]; then
    migration="$2"
    echo "$migration" >> "$PSQL_MIGRATION_LOG"
    [[ "$migration" != "lib/db/migrations/0033_enrollment_event_context.sql" ]]
    exit
  fi
  shift
done
exit 2
`,
    );
    chmodSync(fakePsql, 0o755);

    const result = spawnSync("bash", [bootstrapPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://unused-by-fake-psql",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        PSQL_MIGRATION_LOG: migrationLog,
      },
    });

    assert.notEqual(result.status, 0, "a failed migration must make bootstrap exit non-zero");
    assert.match(
      result.stderr,
      /Database protection migration failed: lib\/db\/migrations\/0033_enrollment_event_context\.sql/,
      "stderr must identify the migration rejected by psql",
    );
    assert.deepEqual(readFileSync(migrationLog, "utf8").trim().split("\n"), [
      "lib/db/migrations/0032_learning_record_link_ownership.sql",
      "lib/db/migrations/0033_enrollment_event_context.sql",
    ]);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});