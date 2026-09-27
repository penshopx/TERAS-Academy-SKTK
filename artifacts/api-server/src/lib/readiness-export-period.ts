import { createHmac, timingSafeEqual } from "node:crypto";

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) throw new Error("SESSION_SECRET is required for readiness export period proofs");
  return value;
}

/** A server-issued, attempt-bound UTC day. No identity or export data is encoded. */
export function issueReadinessExportPeriodProof(attemptKey: string, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const signature = createHmac("sha256", secret()).update(`readiness-export-period:v1:${attemptKey}:${day}`).digest("hex");
  return `v1.${day}.${signature}`;
}

export function verifyReadinessExportPeriodProof(attemptKey: string, proof: string, now = new Date()) {
  const match = /^v1\.(\d{4}-\d{2}-\d{2})\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return null;
  const day = match[1]!;
  if (Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) return null;
  const expected = issueReadinessExportPeriodProof(attemptKey, new Date(`${day}T00:00:00.000Z`));
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) return null;
  const today = now.toISOString().slice(0, 10);
  if (day > today) return null;
  return day;
}