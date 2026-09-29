import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, agentHealthDaysTable, agentRunsTable } from "@workspace/db";
import { and, gte, lte, sql } from "drizzle-orm";
import { logger } from "./logger";

export const AGENT_HEALTH_PAGE_SIZE = 1000;
export const AGENT_HEALTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type AgentRunInput = typeof agentRunsTable.$inferInsert;

// The ledger's primary key rejects duplicate runs. Both records commit or neither does.
export async function recordAgentRun(input: AgentRunInput) {
  const createdAt = input.createdAt ?? new Date();
  const day = createdAt.toISOString().slice(0, 10);
  const fallback = (input.resultSummary as { fallbackUsed?: unknown } | null)?.fallbackUsed === true ? 1 : 0;
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('teras_agent_health_day'), ${day}::date - DATE '2000-01-01')`);
    await tx.insert(agentRunsTable).values({ ...input, createdAt });
    if (day < new Date(Date.now() - 44 * 86400000).toISOString().slice(0, 10)) return;
    await tx.execute(sql`INSERT INTO teras_agent_health_days
      (day, run_count, completed_count, partial_count, failed_count, fallback_count)
      VALUES (${day}::date, 1, ${input.status === "COMPLETED" ? 1 : 0},
        ${input.status === "PARTIAL" ? 1 : 0}, ${input.status === "FAILED" ? 1 : 0}, ${fallback})
      ON CONFLICT (day) DO UPDATE SET
        run_count = teras_agent_health_days.run_count + 1,
        completed_count = teras_agent_health_days.completed_count + EXCLUDED.completed_count,
        partial_count = teras_agent_health_days.partial_count + EXCLUDED.partial_count,
        failed_count = teras_agent_health_days.failed_count + EXCLUDED.failed_count,
        fallback_count = teras_agent_health_days.fallback_count + EXCLUDED.fallback_count`);
  });
}

function dayAtOffset(offset: number) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
}

export async function reconcileAgentHealthDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < dayAtOffset(-44) || day > dayAtOffset(0))
    throw new Error("Agent health reconciliation day outside retention");
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('teras_agent_health_day'), ${day}::date - DATE '2000-01-01')`);
    await tx.execute(sql`INSERT INTO teras_agent_health_days
      (day, run_count, completed_count, partial_count, failed_count, fallback_count)
      SELECT ${day}::date, count(*)::integer,
        count(*) FILTER (WHERE status = 'COMPLETED')::integer,
        count(*) FILTER (WHERE status = 'PARTIAL')::integer,
        count(*) FILTER (WHERE status = 'FAILED')::integer,
        count(*) FILTER (WHERE result_summary->>'fallbackUsed' = 'true')::integer
      FROM teras_agent_runs
      WHERE created_at >= (${day}::date::timestamp AT TIME ZONE 'UTC')
        AND created_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'UTC')
      ON CONFLICT (day) DO UPDATE SET
        run_count = EXCLUDED.run_count, completed_count = EXCLUDED.completed_count,
        partial_count = EXCLUDED.partial_count, failed_count = EXCLUDED.failed_count,
        fallback_count = EXCLUDED.fallback_count`);
  });
}

let ready: Promise<void> | undefined;
export function ensureAgentHealthReady(): Promise<void> {
  ready ??= (async () => {
    // A new Production schema may have tables but not the development-only SQL migration.
    // One winner backfills the retained days; all other instances wait on the global lock.
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('teras_agent_health_backfill'))`);
      const state = await tx.execute(sql`SELECT backfilled_at FROM teras_agent_health_state WHERE id = 'global'`);
      if (state.rows[0]?.backfilled_at) return;
      for (let offset = -44; offset <= 0; offset++) {
        const day = dayAtOffset(offset);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('teras_agent_health_day'), ${day}::date - DATE '2000-01-01')`);
        await tx.execute(sql`INSERT INTO teras_agent_health_days
          (day, run_count, completed_count, partial_count, failed_count, fallback_count)
          SELECT ${day}::date, count(*)::integer,
            count(*) FILTER (WHERE status = 'COMPLETED')::integer,
            count(*) FILTER (WHERE status = 'PARTIAL')::integer,
            count(*) FILTER (WHERE status = 'FAILED')::integer,
            count(*) FILTER (WHERE result_summary->>'fallbackUsed' = 'true')::integer
          FROM teras_agent_runs
          WHERE created_at >= (${day}::date::timestamp AT TIME ZONE 'UTC')
            AND created_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'UTC')
          ON CONFLICT (day) DO UPDATE SET
            run_count = EXCLUDED.run_count, completed_count = EXCLUDED.completed_count,
            partial_count = EXCLUDED.partial_count, failed_count = EXCLUDED.failed_count,
            fallback_count = EXCLUDED.fallback_count`);
      }
      await tx.execute(sql`INSERT INTO teras_agent_health_state (id, backfilled_at) VALUES ('global', now())
        ON CONFLICT (id) DO UPDATE SET backfilled_at = EXCLUDED.backfilled_at`);
    });
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}

// The projection is a calendar-day report, deliberately independent of the rolling ledger cursor.
export async function agentHealthPeriod(now = new Date()) {
  await ensureAgentHealthReady();
  const today = now.toISOString().slice(0, 10);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)).toISOString().slice(0, 10);
  const rows = await db.select().from(agentHealthDaysTable)
    .where(and(gte(agentHealthDaysTable.day, first), lte(agentHealthDaysTable.day, today)))
    .orderBy(agentHealthDaysTable.day).limit(30);
  const byDay = new Map(rows.map(row => [row.day, row]));
  const trends = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29 + index)).toISOString().slice(0, 10);
    const row = byDay.get(day);
    return { day, runCount: row?.runCount ?? 0, completedCount: row?.completedCount ?? 0,
      partialCount: row?.partialCount ?? 0, failedCount: row?.failedCount ?? 0,
      fallbackCount: row?.fallbackCount ?? 0 };
  });
  return {
    fromDay: first, toDay: today, trends,
    totals: {
      runCount: trends.reduce((sum, day) => sum + day.runCount, 0),
      completedCount: trends.reduce((sum, day) => sum + day.completedCount, 0),
      partialCount: trends.reduce((sum, day) => sum + day.partialCount, 0),
      failedCount: trends.reduce((sum, day) => sum + day.failedCount, 0),
      fallbackCount: trends.reduce((sum, day) => sum + day.fallbackCount, 0),
    },
  };
}

// Reconcile yesterday (including late arrivals) and expire old aggregates daily.
// The database function takes the same per-day transaction lock as the insert trigger.
export function startAgentHealthMaintenance() {
  const maintain = async () => {
    try {
      await ensureAgentHealthReady();
      await reconcileAgentHealthDay(dayAtOffset(-1));
      await db.transaction(async tx => {
        await tx.execute(sql`DELETE FROM teras_agent_health_days WHERE day < (now() AT TIME ZONE 'UTC')::date - 44`);
      });
    } catch (err) {
      logger.error({ err }, "Agent health maintenance failed");
    }
  };
  void maintain();
  setInterval(() => { void maintain(); }, 24 * 60 * 60 * 1000).unref();
}

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