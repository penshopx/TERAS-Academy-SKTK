import { createHash } from "node:crypto";
import { z } from "zod";

export const TRAINER_INTELLIGENCE_AGENT = {
  id: "trainer-intelligence",
  version: "1.0.0",
  maxPermission: "PROPOSE",
  execution: "NONE",
  purpose: "Read-only, assignment-scoped trainer analysis",
} as const;

export const EVIDENCE_TRIAGE_AGENT = {
  id: "evidence-triage",
  version: "1.0.0",
  maxPermission: "PROPOSE",
  execution: "NONE",
  purpose: "Read-only preparation evidence triage for assigned Path A contexts",
} as const;

export const TRAINER_INTELLIGENCE_TOOLS = [
  { id: "get_trainer_assignment_projection", permission: "READ", risk: "READ_ONLY", approval: "NONE", idempotency: "NOT_APPLICABLE" },
] as const;

export const PolicyDecision = z.enum(["ALLOW_READ", "ALLOW_PROPOSE", "REQUIRES_APPROVAL", "DENY"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const Grounding = z.enum(["grounded", "partially_grounded", "insufficient"]);
export const AgentClaim = z.object({
  claim: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).max(20),
  confidence: z.enum(["high", "medium", "low"]),
  grounding: Grounding,
});
export const EvidenceEnvelope = z.object({
  claims: z.array(AgentClaim).max(30),
  limitations: z.array(z.string().trim().min(1).max(300)).max(20),
  recommendedActions: z.array(z.object({
    action: z.string().trim().min(1).max(300),
    evidenceRefs: z.array(z.string().trim().min(1).max(160)).max(20),
  })).max(20),
  sourceRefs: z.array(z.string().trim().min(1).max(160)).max(50),
  asOf: z.string().datetime(),
  advisoryNotice: z.literal("Advisory only. This analysis does not determine competency, certification, readiness, or official assessment outcomes."),
});
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelope>;
export const ProviderSelection = z.object({
  factCodes: z.array(z.string()),
}).strict();
export type ProviderSelection = z.infer<typeof ProviderSelection>;

export const AgentRunStatus = z.enum(["PLANNED", "RUNNING", "COMPLETED", "FAILED", "PARTIAL"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

const FORBIDDEN_CLAIMS = /\b(certif(?:ied|ication)|sertif(?:ikasi|ikat)|official(?:ly)? competent|kompeten(?:si)? resmi|lulus sertifikasi|competent resmi|readiness decision|keputusan kompetensi)\b/i;
export function sanitizeEvidenceEnvelope(value: unknown, fallback: EvidenceEnvelope): EvidenceEnvelope {
  const parsed = EvidenceEnvelope.safeParse(value);
  if (!parsed.success) return fallback;
  const claims = parsed.data.claims.filter((item) => !FORBIDDEN_CLAIMS.test(item.claim));
  const recommendedActions = parsed.data.recommendedActions.filter((item) => !FORBIDDEN_CLAIMS.test(item.action));
  return { ...parsed.data, claims, recommendedActions, advisoryNotice: fallback.advisoryNotice };
}
export function validateProviderSelection(value: unknown, expected: string[]): ProviderSelection | null {
  const parsed = ProviderSelection.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.factCodes.length !== expected.length ||
    new Set(parsed.data.factCodes).size !== parsed.data.factCodes.length ||
    parsed.data.factCodes.some(code => !expected.includes(code))) return null;
  return parsed.data;
}
export function resultHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function policyFor(agentId: string, requested: "READ" | "PROPOSE"): PolicyDecision {
  if (agentId !== TRAINER_INTELLIGENCE_AGENT.id && agentId !== EVIDENCE_TRIAGE_AGENT.id) return "DENY";
  return requested === "READ" ? "ALLOW_READ" : "ALLOW_PROPOSE";
}