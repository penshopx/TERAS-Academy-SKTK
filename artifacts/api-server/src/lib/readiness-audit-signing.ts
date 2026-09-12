import { createPrivateKey, createPublicKey, sign } from "node:crypto";

export type ReadinessAuditPublicKey = {
  keyId: string;
  version: number;
  algorithm: "Ed25519";
  publicKeyPem: string;
};

type ReadinessAuditSigningKey = ReadinessAuditPublicKey & {
  privateKeyPem?: string;
  active?: boolean;
};

function configuredKeys(): ReadinessAuditSigningKey[] {
  const raw = process.env.TERAS_READINESS_AUDIT_SIGNING_KEYS;
  if (!raw) throw new Error("TERAS_READINESS_AUDIT_SIGNING_KEYS is not configured");
  const keys = JSON.parse(raw) as unknown;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("Readiness audit signing keyring must be a non-empty array");
  const seen = new Set<string>();
  const keyIdByVersion = new Map<number, string>();
  return keys.map((value: any) => {
    if (!value || typeof value.keyId !== "string" || !value.keyId
      || !Number.isInteger(value.version) || value.version < 1
      || typeof value.publicKeyPem !== "string" || !value.publicKeyPem) {
      throw new Error("Every readiness audit signing key requires keyId, positive version, and publicKeyPem");
    }
    if (seen.has(value.keyId)) throw new Error(`Duplicate readiness audit signing key ID: ${value.keyId}`);
    seen.add(value.keyId);
    const conflictingKeyId = keyIdByVersion.get(value.version);
    if (conflictingKeyId) {
      throw new Error(
        `Duplicate readiness audit signing key version ${value.version}: key IDs ${conflictingKeyId} and ${value.keyId}`,
      );
    }
    keyIdByVersion.set(value.version, value.keyId);
    const publicKey = createPublicKey(value.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`Signing key ${value.keyId} is not Ed25519`);
    if (value.privateKeyPem) {
      const privateKey = createPrivateKey(value.privateKeyPem);
      if (privateKey.asymmetricKeyType !== "ed25519"
        || createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !== publicKey.export({ type: "spki", format: "pem" }).toString()) {
        throw new Error(`Private and public key do not match for ${value.keyId}`);
      }
    }
    return {
      keyId: value.keyId,
      version: value.version,
      algorithm: "Ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: value.privateKeyPem,
      active: value.active === true,
    };
  });
}

export function readinessAuditPublicKeys(): ReadinessAuditPublicKey[] {
  return configuredKeys()
    .map(({ keyId, version, algorithm, publicKeyPem }) => ({ keyId, version, algorithm, publicKeyPem }))
    .sort((left, right) => right.version - left.version);
}

export function readinessAuditSigner() {
  const keys = configuredKeys();
  const active = keys.filter(key => key.active);
  if (active.length !== 1 || !active[0].privateKeyPem) {
    throw new Error("Exactly one active readiness audit signing key with a private key is required");
  }
  const highestPublishedVersion = Math.max(...keys.map(key => key.version));
  if (active[0].version < highestPublishedVersion) {
    throw new Error(
      `Readiness audit signing key ${active[0].keyId} version ${active[0].version} cannot be activated because published version ${highestPublishedVersion} is newer`,
    );
  }
  return (checksum: string) => ({
      algorithm: active[0].algorithm,
      keyId: active[0].keyId,
      keyVersion: active[0].version,
      value: sign(null, Buffer.from(checksum, "hex"), active[0].privateKeyPem!).toString("base64"),
      publicKeyUrl: "/api/readiness-audit/public-keys",
    });
}