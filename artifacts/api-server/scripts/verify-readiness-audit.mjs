#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
const publicKeysPath = process.argv[3];
if (!path || !publicKeysPath) {
  console.error("Usage: node verify-readiness-audit.mjs <readiness-audit.json> <public-keys.json-or-pem>");
  process.exit(2);
}

try {
  const exported = JSON.parse(await readFile(path, "utf8"));
  const canonicalPayload = {
    schemaVersion: exported.schemaVersion,
    exportedAt: exported.exportedAt,
    filters: exported.filters,
    recordCount: exported.recordCount,
    records: exported.records,
  };
  const actual = createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
  const expected = exported.integrity?.checksum;
  const signature = exported.integrity?.signature;

  if (exported.integrity?.algorithm !== "SHA-256" || actual !== expected) {
    console.error(`FAILED: expected ${expected ?? "(missing checksum)"}, calculated ${actual}`);
    process.exit(1);
  }

  if (signature?.algorithm !== "Ed25519" || typeof signature.keyId !== "string"
    || !Number.isInteger(signature.keyVersion) || typeof signature.value !== "string") {
    throw new Error("missing or invalid digital signature metadata");
  }
  const keyText = await readFile(publicKeysPath, "utf8");
  const keyDocument = keyText.trimStart().startsWith("-----BEGIN PUBLIC KEY-----")
    ? { keys: [{ keyId: signature.keyId, version: signature.keyVersion, algorithm: "Ed25519", publicKeyPem: keyText }] }
    : JSON.parse(keyText);
  const key = keyDocument.keys?.find(candidate => candidate.keyId === signature.keyId
    && candidate.version === signature.keyVersion && candidate.algorithm === "Ed25519");
  if (!key) throw new Error(`public key not found for ${signature.keyId} version ${signature.keyVersion}`);
  const publicKey = createPublicKey(key.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(expected, "hex"), publicKey, Buffer.from(signature.value, "base64"))) {
    throw new Error("digital signature verification failed");
  }

  console.log(`VERIFIED: ${actual}; issuer TERAS; key ${signature.keyId} v${signature.keyVersion}`);
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}