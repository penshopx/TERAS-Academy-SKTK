import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertCanCreateDisposableDatabase,
  canDropStaleIntegrationSchema,
  createIntegrationSchemaName,
  isStaleOwnedIntegrationSchema,
  safeSchemaPrefix,
} from "./integration-schema-runner";

const schemaPrefix = "diagnostic_integration";
const validSuffix = "123456789abc4def8abc123456789abc";
const now = new Date("2026-09-10T12:00:00.000Z");
const staleSchemaAgeMs = 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

function metadata(createdAt: string) {
  return JSON.stringify({
    kind: "teras-integration-test",
    version: 1,
    schemaPrefix,
    createdAt,
  });
}

test("accepts an integration schema prefix at the PostgreSQL identifier limit", () => {
  const prefixAtLimit = `a${"b".repeat(29)}`;
  assert.equal(safeSchemaPrefix(prefixAtLimit), prefixAtLimit);
  const schemaName = createIntegrationSchemaName(prefixAtLimit, validSuffix);
  assert.equal(Buffer.byteLength(schemaName, "utf8"), 63);
});

test("rejects an integration schema prefix that leaves no room for the random suffix", () => {
  const prefixOverLimit = `a${"b".repeat(30)}`;
  assert.throws(
    () => safeSchemaPrefix(prefixOverLimit),
    (error: Error) => {
      assert.match(error.message, /maximum length is 30 bytes/);
      assert.match(error.message, /separator and 32-byte random suffix/);
      assert.match(error.message, /received 31 bytes/);
      return true;
    },
  );
});

test("rejects a prefix that would make the complete schema name exceed 63 bytes", () => {
  const prefixOverLimit = `a${"b".repeat(30)}`;
  assert.throws(
    () => createIntegrationSchemaName(prefixOverLimit, validSuffix),
    (error: Error) => {
      assert.match(error.message, /maximum length is 30 bytes/);
      assert.match(error.message, /32-byte random suffix/);
      return true;
    },
  );
});

test("rejects empty, short, or identifier-unsafe integration schema suffixes", () => {
  for (const suffix of [
    "",
    "a".repeat(31),
    "a".repeat(31) + "-",
    "A".repeat(32),
    "0".repeat(32),
  ]) {
    assert.throws(
      () => createIntegrationSchemaName("integration", suffix),
      (error: Error) => {
        assert.match(error.message, /Invalid integration schema suffix/);
        assert.match(error.message, /exactly 32 lowercase hexadecimal characters/);
        assert.match(error.message, /compact UUID v4 format/);
        return true;
      },
    );
  }
});

test("generates UUID v4 suffixes that remain unique across concurrent processes", async () => {
  const processCount = 4;
  const suffixesPerProcess = 50;
  const script = [
    'import { generateIntegrationSchemaSuffix } from "./src/integration-schema-runner.ts";',
    `console.log(Array.from({ length: ${suffixesPerProcess} }, generateIntegrationSchemaSuffix).join("\\n"));`,
  ].join(" ");
  const results = await Promise.all(
    Array.from({ length: processCount }, () =>
      execFileAsync("pnpm", ["exec", "tsx", "--eval", script]),
    ),
  );
  const generatedSuffixes = results.flatMap(({ stdout }) =>
    stdout.trim().split("\n"),
  );

  assert.equal(generatedSuffixes.length, processCount * suffixesPerProcess);
  assert.equal(new Set(generatedSuffixes).size, generatedSuffixes.length);
  for (const suffix of generatedSuffixes) {
    assert.equal(suffix.length, 32);
    assert.match(suffix, /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  }
});

test("keeps an old integration schema while its advisory lock is active", () => {
  assert.equal(canDropStaleIntegrationSchema({
    schemaName: `${schemaPrefix}_active_but_old`,
    schemaPrefix,
    comment: metadata("2026-09-10T10:00:00.000Z"),
    now,
    staleSchemaAgeMs,
    advisoryLockAcquired: false,
  }), false);
});

test("selects an old owned integration schema for lock-guarded cleanup", () => {
  assert.equal(canDropStaleIntegrationSchema({
    schemaName: `${schemaPrefix}_orphaned`,
    schemaPrefix,
    comment: metadata("2026-09-10T10:00:00.000Z"),
    now,
    staleSchemaAgeMs,
    advisoryLockAcquired: true,
  }), true);
});

test("keeps unknown schema names and ownership metadata", () => {
  assert.equal(isStaleOwnedIntegrationSchema({
    schemaName: "public",
    schemaPrefix,
    comment: metadata("2026-09-01T00:00:00.000Z"),
    now,
    staleSchemaAgeMs,
  }), false);
  assert.equal(isStaleOwnedIntegrationSchema({
    schemaName: `${schemaPrefix}_unknown`,
    schemaPrefix,
    comment: "application schema",
    now,
    staleSchemaAgeMs,
  }), false);
});

test("accepts a test role that can create a disposable database", async () => {
  let queryCount = 0;
  await assertCanCreateDisposableDatabase({
    query: async () => {
      queryCount += 1;
      return {
        rows: [{ role_name: "ci_test", can_create_database: true }],
      };
    },
  } as never);
  assert.equal(queryCount, 1);
});

test("explains the minimum privilege and database isolation when CREATEDB is missing", async () => {
  await assert.rejects(
    assertCanCreateDisposableDatabase({
      query: async () => ({
        rows: [{ role_name: "ci_test", can_create_database: false }],
      }),
    } as never),
    (error: Error) => {
      assert.match(error.message, /CREATEDB/);
      assert.match(error.message, /dedicated CI\/test role/);
      assert.match(error.message, /separate disposable test database/);
      assert.match(error.message, /does not modify the application database/);
      assert.match(error.message, /Current role: ci_test/);
      return true;
    },
  );
});