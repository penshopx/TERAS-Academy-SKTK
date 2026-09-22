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
  let keyDocument;
  if (keyText.trimStart().startsWith("-----BEGIN PUBLIC KEY-----")) {
    keyDocument = { keys: [{ keyId: signature.keyId, version: signature.keyVersion, algorithm: "Ed25519", publicKeyPem: keyText }] };
  } else {
    try {
      keyDocument = JSON.parse(keyText);
    } catch {
      throw new Error("public-key file could not be read as valid JSON");
    }
  }
  if (!Array.isArray(keyDocument.keys)) {
    throw new Error("invalid public key manifest: keys must be an array");
  }
  const keyIdByVersion = new Map();
  for (const [index, candidate] of keyDocument.keys.entries()) {
    if (typeof candidate?.keyId !== "string") {
      throw new Error(`invalid public key manifest: keys[${index}].keyId must be a string`);
    }
    if (!Number.isInteger(candidate.version)) {
      throw new Error(`invalid public key manifest: keys[${index}].version must be an integer`);
    }
    if (typeof candidate.algorithm !== "string") {
      throw new Error(`invalid public key manifest: keys[${index}].algorithm must be a string`);
    }
    if (typeof candidate.publicKeyPem !== "string") {
      throw new Error(`invalid public key manifest: keys[${index}].publicKeyPem must be a string`);
    }
    const existingKeyId = keyIdByVersion.get(candidate.version);
    if (existingKeyId !== undefined && existingKeyId !== candidate.keyId) {
      throw new Error(
        `ambiguous public key history: version ${candidate.version} is assigned to both ${existingKeyId} and ${candidate.keyId}`,
      );
    }
    keyIdByVersion.set(candidate.version, candidate.keyId);
  }
  const key = keyDocument.keys.find(candidate => candidate.keyId === signature.keyId
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