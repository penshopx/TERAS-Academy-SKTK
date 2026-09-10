import assert from "node:assert/strict";
import test from "node:test";
import {
  canDropStaleIntegrationSchema,
  isStaleOwnedIntegrationSchema,
} from "./integration-schema-runner";

const schemaPrefix = "diagnostic_integration";
const now = new Date("2026-09-10T12:00:00.000Z");
const staleSchemaAgeMs = 60 * 60 * 1000;

function metadata(createdAt: string) {
  return JSON.stringify({
    kind: "teras-integration-test",
    version: 1,
    schemaPrefix,
    createdAt,
  });
}

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