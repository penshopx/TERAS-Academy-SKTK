import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const AGENT_HEALTH_PAGE_SIZE = 1000;
export const AGENT_HEALTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Position = { from: string; to: string; createdAt: string; id: string };

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET is required for agent health cursors");
  return createHash("sha256").update(secret).digest();
}

// Encrypt rather than merely sign: even the cursor must not expose a stable run ID.
export function sealAgentCursor(position: Position): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(position), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64url");
}

export function openAgentCursor(value: unknown, now = new Date()): Position | null {
  if (typeof value !== "string" || value.length > 1024 || !/^[\w-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.id !== "string" || !p.id || p.id.length > 200) return null;
    if (typeof p.from !== "string" || typeof p.to !== "string" || typeof p.createdAt !== "string") return null;
    const from = Date.parse(p.from), to = Date.parse(p.to), createdAt = Date.parse(p.createdAt);
    if (![from, to, createdAt].every(Number.isFinite) || to - from !== AGENT_HEALTH_WINDOW_MS ||
      to > now.getTime() + 60_000 || to < now.getTime() - AGENT_HEALTH_WINDOW_MS ||
      createdAt < from || createdAt > to) return null;
    return { from: p.from, to: p.to, createdAt: p.createdAt, id: p.id };
  } catch {
    return null;
  }
}

// Untrusted historical labels are mapped to a small catalog, never copied into an admin response.
export function safeAgentDimension(agentId: string, version: string, provider: string | null, model: string | null) {
  return {
    agentVersion: ["trainer-intelligence", "evidence-triage"].includes(agentId) && version === "1.0.0"
      ? `${agentId} 1.0.0` : "other",
    provider: provider === "openrouter" ? "openrouter" : null,
    model: provider === "openrouter" && model === "qwen/qwen3.8-flash" ? "qwen/qwen3.8-flash" : null,
  };
}