/**
 * TERAS Agent Quality Gate.  The evaluator in this file is deliberately
 * database-independent so that its policy remains easy to regression test.
 */
export const TRAINER_INTELLIGENCE_AGENT_ID = "trainer-intelligence";
export const QUALITY_GATE_POLICY = {
  version: "1.0.0",
  lookbackDays: 30,
  minimumRuns: 100,
  minimumObservationDays: 14,
  maxFailedRate: 0.01,
  minCompletedRate: 0.95,
  maxFallbackRate: 0.05,
  maxP95LatencyMs: 15_000,
} as const;

export type GateStatus = "PASS" | "NOT_READY" | "FAIL";
export type GateEnvironment = "production" | "development" | "test" | "unknown";
export type AgentRunSample = {
  agentId: string;
  agentVersion: string;
  provider: string | null;
  model: string | null;
  status: string;
  fallbackUsed: boolean;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
};

export type GateResult = {
  status: GateStatus;
  canonical: true;
  policyVersion: string;
  environment: GateEnvironment;
  effectiveWindow: { from: string; to: string; lookbackDays: number };
  samplePeriod: { from: string | null; to: string | null; observationDays: number };
  sample: { eligibleRuns: number; completedRuns: number; failedRuns: number; fallbackRuns: number };
  rates: { completed: number; failed: number; fallback: number };
  p95TerminalLatencyMs: number | null;
  distributions: Array<{ agentVersion: string; provider: string; model: string; runs: number }>;
  reasons: string[];
  limitation: string;
};

const TERMINAL = new Set(["COMPLETED", "FAILED", "PARTIAL"]);
const iso = (value: Date | string): string => new Date(value).toISOString();
const finiteDate = (value: Date | string | null): Date | null => {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};
const pct = (value: number): number => value;

export function detectGateEnvironment(env: NodeJS.ProcessEnv = process.env): GateEnvironment {
  const name = (env.NODE_ENV ?? "").toLowerCase();
  if (name === "test") return "test";
  if (name === "development" || name === "dev") return "development";
  if (name === "production" || env.REPLIT_DEPLOYMENT === "1") return "production";
  return "unknown";
}

export function evaluateAgentQualityGate(
  rows: readonly AgentRunSample[],
  options: { now: Date; environment: GateEnvironment; windowFrom: Date; windowTo?: Date },
): GateResult {
  const to = options.windowTo ?? options.now;
  const terminal = rows.filter((row) =>
    row.agentId === TRAINER_INTELLIGENCE_AGENT_ID &&
    TERMINAL.has(row.status) &&
    (() => { const date = finiteDate(row.createdAt); return date !== null && date >= options.windowFrom && date <= to; })());
  const dates = terminal.map((row) => finiteDate(row.createdAt)!).sort((a, b) => a.getTime() - b.getTime());
  const observationDays = dates.length ? (dates[dates.length - 1]!.getTime() - dates[0]!.getTime()) / 86_400_000 : 0;
  const completedRuns = terminal.filter((row) => row.status === "COMPLETED").length;
  const failedRuns = terminal.filter((row) => row.status === "FAILED").length;
  const fallbackRuns = terminal.filter((row) => row.fallbackUsed === true).length;
  const latencies = terminal.map((row) => {
    const start = finiteDate(row.startedAt);
    const end = finiteDate(row.completedAt);
    if (!start || !end) return null;
    const value = end.getTime() - start.getTime();
    return Number.isFinite(value) && value >= 0 ? value : null;
  }).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null;
  const count = terminal.length;
  const rates = {
    completed: count ? pct(completedRuns / count) : 0,
    failed: count ? pct(failedRuns / count) : 0,
    fallback: count ? pct(fallbackRuns / count) : 0,
  };
  const dimensions = new Map<string, { agentVersion: string; provider: string; model: string; runs: number }>();
  for (const row of terminal) {
    const provider = row.provider ?? "(unknown)";
    const model = row.model ?? "(unknown)";
    const key = `${row.agentVersion}\u0000${provider}\u0000${model}`;
    const current = dimensions.get(key) ?? { agentVersion: row.agentVersion, provider, model, runs: 0 };
    current.runs++;
    dimensions.set(key, current);
  }
  const reasons: string[] = [];
  if (options.environment !== "production") reasons.push(`Environment is ${options.environment}; canonical PASS requires production.`);
  if (count < QUALITY_GATE_POLICY.minimumRuns) reasons.push(`Eligible terminal runs ${count} < ${QUALITY_GATE_POLICY.minimumRuns}.`);
  if (observationDays < QUALITY_GATE_POLICY.minimumObservationDays) reasons.push(`Observation period ${observationDays} days < ${QUALITY_GATE_POLICY.minimumObservationDays}.`);
  if (rates.failed > QUALITY_GATE_POLICY.maxFailedRate) reasons.push(`Failed rate ${(rates.failed * 100).toFixed(2)}% exceeds 1%.`);
  if (rates.completed < QUALITY_GATE_POLICY.minCompletedRate) reasons.push(`Completed rate ${(rates.completed * 100).toFixed(2)}% is below 95%.`);
  if (rates.fallback > QUALITY_GATE_POLICY.maxFallbackRate) reasons.push(`Fallback rate ${(rates.fallback * 100).toFixed(2)}% exceeds 5%.`);
  if (p95 === null) reasons.push("No valid terminal latency observations.");
  else if (p95 > QUALITY_GATE_POLICY.maxP95LatencyMs) reasons.push(`p95 terminal latency ${p95}ms exceeds 15000ms.`);
  const readinessFailure = options.environment !== "production" || count < QUALITY_GATE_POLICY.minimumRuns || observationDays < QUALITY_GATE_POLICY.minimumObservationDays || p95 === null;
  const metricFailure = rates.failed > QUALITY_GATE_POLICY.maxFailedRate || rates.completed < QUALITY_GATE_POLICY.minCompletedRate || rates.fallback > QUALITY_GATE_POLICY.maxFallbackRate || (p95 !== null && p95 > QUALITY_GATE_POLICY.maxP95LatencyMs);
  return {
    status: readinessFailure ? "NOT_READY" : metricFailure ? "FAIL" : "PASS",
    canonical: true, policyVersion: QUALITY_GATE_POLICY.version, environment: options.environment,
    effectiveWindow: { from: iso(options.windowFrom), to: iso(to), lookbackDays: QUALITY_GATE_POLICY.lookbackDays },
    samplePeriod: { from: dates[0] ? dates[0].toISOString() : null, to: dates.at(-1)?.toISOString() ?? null, observationDays },
    sample: { eligibleRuns: count, completedRuns, failedRuns, fallbackRuns }, rates,
    p95TerminalLatencyMs: p95, distributions: [...dimensions.values()], reasons,
    limitation: "PASS covers canonical operational metric gates only. Privacy leakage, authorization, append-only protection, and domain non-mutation are structural/regression gates and require separate verified evidence before governance declares Verified Operational Baseline.",
  };
}

export function renderAgentQualityGate(result: GateResult, format: "text" | "json" = "text"): string {
  return format === "json" ? JSON.stringify(result, null, 2) :
    [
      `TERAS Agent Quality Gate: ${result.status}`,
      `Environment: ${result.environment} (canonical policy ${result.policyVersion})`,
      `Effective window: ${result.effectiveWindow.from} to ${result.effectiveWindow.to} (${result.effectiveWindow.lookbackDays} days)`,
      `Eligible terminal runs: ${result.sample.eligibleRuns}; observation: ${result.samplePeriod.observationDays.toFixed(2)} days`,
      `Rates: completed ${(result.rates.completed * 100).toFixed(2)}%, failed ${(result.rates.failed * 100).toFixed(2)}%, fallback ${(result.rates.fallback * 100).toFixed(2)}%`,
      `p95 terminal latency: ${result.p95TerminalLatencyMs === null ? "unavailable" : `${result.p95TerminalLatencyMs}ms`}`,
      result.reasons.length ? `Reasons: ${result.reasons.join(" ")}` : "All canonical thresholds passed.",
      `Limitation: ${result.limitation}`,
    ].join("\n");
}

async function main(): Promise<void> {
  const format = process.argv.includes("--format=json") ? "json" : "text";
  const environment = detectGateEnvironment();
  const to = new Date();
  const from = new Date(to.getTime() - QUALITY_GATE_POLICY.lookbackDays * 86_400_000);
  const { db, agentRunsTable } = await import("@workspace/db");
  const { and, eq, gte, lte, sql } = await import("drizzle-orm");
  const rows = await db.select({
    agentId: agentRunsTable.agentId, agentVersion: agentRunsTable.agentVersion,
    provider: agentRunsTable.provider, model: agentRunsTable.model, status: agentRunsTable.status,
    // Project only the allowlisted scalar; raw result_summary must never leave the DB.
    fallbackUsed: sql<boolean>`coalesce(${agentRunsTable.resultSummary}->>'fallbackUsed', 'false') = 'true'`,
    createdAt: agentRunsTable.createdAt,
    startedAt: agentRunsTable.startedAt, completedAt: agentRunsTable.completedAt,
  }).from(agentRunsTable).where(and(eq(agentRunsTable.agentId, TRAINER_INTELLIGENCE_AGENT_ID), gte(agentRunsTable.createdAt, from), lte(agentRunsTable.createdAt, to)));
  const result = evaluateAgentQualityGate(rows, { now: to, environment, windowFrom: from, windowTo: to });
  process.stdout.write(`${renderAgentQualityGate(result, format)}\n`);
  process.exitCode = result.status === "PASS" ? 0 : result.status === "NOT_READY" ? 2 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => { process.stderr.write(`Agent quality gate execution error: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; });
}