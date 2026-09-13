import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
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