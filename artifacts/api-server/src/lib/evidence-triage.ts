import { inArray } from "drizzle-orm";
import { agentRunsTable, db, evidenceRequirementsTable, modulesTable } from "@workspace/db";
import { EVIDENCE_TRIAGE_AGENT, policyFor, resultHash, validateProviderSelection, type AgentRunStatus } from "./agentic";
import { evidenceRecords, selectedBaselineModuleIds, workspaceAssignmentContexts } from "./teras";

const OBJECTIVE = "Prioritize preparation evidence gaps in assigned Path A contexts.";
const ADVISORY = "Advisory only. This triage does not decide evidence validity, readiness, competency, certification, or official assessment outcomes.";
const LIMITATION = "Only assigned, active Path A contexts and their pinned baseline modules are included. A missing submission is a preparation prompt, not a review decision.";
const CATEGORIES = {
  NEEDS_REVISION: { priority: "High", label: "Perlu revisi", action: "Periksa kembali bukti yang sudah ditandai perlu revisi." },
  INCOMPLETE_QUALITY: { priority: "High", label: "Kualitas belum lengkap", action: "Periksa aspek kualitas yang belum terpenuhi pada review terbaru." },
  TYPE_MISMATCH: { priority: "High", label: "Jenis bukti tidak sesuai", action: "Periksa jenis pengajuan terhadap ketentuan bukti modul." },
  MISSING_SUBMISSION: { priority: "Normal", label: "Belum ada bukti", action: "Periksa kebutuhan bukti untuk modul yang belum memiliki pengajuan." },
  AWAITING_REVIEW: { priority: "Normal", label: "Menunggu review", action: "Tinjau pengajuan yang belum memiliki review." },
} as const;
export type TriageCategory = keyof typeof CATEGORIES;
type Finding = { learnerId: string; learnerName: string; pathwayId: string; moduleId: string; evidenceRef: string };
export type TriageProjection = { asOf: string; findings: Record<TriageCategory, Finding[]> };
const emptyFindings = (): TriageProjection["findings"] => ({
  NEEDS_REVISION: [], INCOMPLETE_QUALITY: [], TYPE_MISMATCH: [], MISSING_SUBMISSION: [], AWAITING_REVIEW: [],
});

export async function evidenceTriageProjection(trainerId: string): Promise<TriageProjection> {
  const contexts = (await workspaceAssignmentContexts(trainerId, "trainer"))
    .filter(context => context.pathway.purpose === "capability-development");
  const findings = emptyFindings();
  for (const context of contexts) {
    const moduleIds = await selectedBaselineModuleIds(context.pathway.id, context.baselineVersionId);
    if (!moduleIds.size) continue;
    const [requirements, modules, evidence] = await Promise.all([
      db.select({ moduleId: evidenceRequirementsTable.moduleId, allowedTypes: evidenceRequirementsTable.allowedTypes }).from(evidenceRequirementsTable)
        .where(inArray(evidenceRequirementsTable.moduleId, [...moduleIds])),
      db.select({ id: modulesTable.id, programId: modulesTable.programId }).from(modulesTable)
        .where(inArray(modulesTable.id, [...moduleIds])),
      evidenceRecords(context.learner.id, context.pathway.id, context.baselineVersionId),
    ]);
    const allowed = new Set(modules.filter(module => module.programId === context.program.id).map(module => module.id));
    const allowedTypes = new Map<string, Set<string>>();
    for (const requirement of requirements) {
      const types = allowedTypes.get(requirement.moduleId) ?? new Set<string>();
      for (const type of requirement.allowedTypes) types.add(type);
      allowedTypes.set(requirement.moduleId, types);
    }
    const finding = (moduleId: string, evidenceRef: string): Finding => ({
      learnerId: context.learner.id, learnerName: context.learner.name,
      pathwayId: context.pathway.id, moduleId, evidenceRef,
    });
    const submitted = new Set<string>();
    for (const item of evidence) {
      if (!allowed.has(item.moduleId)) continue;
      submitted.add(item.moduleId);
      const ref = `evidence:${item.id}`;
      if (item.status === "Needs revision") findings.NEEDS_REVISION.push(finding(item.moduleId, ref));
      else if (item.status === "Valid" && Object.values(item.quality).some(value => !value))
        findings.INCOMPLETE_QUALITY.push(finding(item.moduleId, ref));
      else if (allowedTypes.get(item.moduleId)?.size && !allowedTypes.get(item.moduleId)!.has(item.type))
        findings.TYPE_MISMATCH.push(finding(item.moduleId, ref));
      else if (item.status !== "Valid") findings.AWAITING_REVIEW.push(finding(item.moduleId, ref));
    }
    for (const moduleId of new Set(requirements.map(row => row.moduleId))) {
      if (allowed.has(moduleId) && !submitted.has(moduleId))
        findings.MISSING_SUBMISSION.push(finding(moduleId, `module:${moduleId}`));
    }
  }
  return { asOf: new Date().toISOString(), findings };
}

type Fact = { code: string; kind: TriageCategory; count: number };
function factsFor(projection: TriageProjection): Fact[] {
  return (Object.keys(CATEGORIES) as TriageCategory[])
    .filter(kind => projection.findings[kind].length > 0)
    .map((kind, index) => ({ code: `fact-${index + 1}`, kind, count: projection.findings[kind].length }));
}

export function renderEvidenceTriage(projection: TriageProjection, order: string[] = factsFor(projection).map(fact => fact.code)) {
  const facts = factsFor(projection);
  const byCode = new Map(facts.map(fact => [fact.code, fact]));
  return {
    asOf: projection.asOf,
    categories: order.map(code => {
      const fact = byCode.get(code)!;
      const definition = CATEGORIES[fact.kind];
      return {
        category: fact.kind, label: definition.label, priority: definition.priority,
        count: fact.count, action: definition.action,
        items: projection.findings[fact.kind].slice(0, 20),
        omittedCount: Math.max(0, fact.count - 20),
      };
    }),
    limitations: [LIMITATION, "Hanya 20 referensi pertama per kategori ditampilkan; jumlah kategori mencakup seluruh bukti dalam lingkup."],
    advisoryNotice: ADVISORY,
  };
}

type Completion = (payload: { system: string; user: string }) => Promise<unknown>;
const defaultCompletion: Completion = async ({ system, user }) => {
  const { openrouter } = await import("@workspace/integrations-openrouter-ai");
  const completion = await openrouter.chat.completions.create({
    model: "qwen/qwen3.8-flash", max_tokens: 256, temperature: 0.1,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  }, { timeout: 15_000 });
  const content = completion.choices[0]?.message?.content;
  return typeof content === "string" ? JSON.parse(content) : content;
};

export async function createEvidenceTriageRun(trainerId: string, complete: Completion = defaultCompletion) {
  const startedAt = new Date();
  const runId = `agent-run-${crypto.randomUUID()}`;
  let status: AgentRunStatus = "COMPLETED";
  let provider: string | null = null;
  let model: string | null = null;
  let response: ReturnType<typeof renderEvidenceTriage> | null = null;
  let refs: string[] = [];
  try {
    const projection = await evidenceTriageProjection(trainerId);
    const facts = factsFor(projection);
    refs = facts.map(fact => fact.code);
    let order = refs;
    if (facts.length && (process.env.NODE_ENV !== "test" || complete !== defaultCompletion)) {
      provider = "openrouter"; model = "qwen/qwen3.8-flash";
      try {
        const selection = validateProviderSelection(await complete({
          system: 'Return only strict JSON {"factCodes":["fact-N",...]}. Reorder every supplied opaque code exactly once. No text, citations, identifiers, or timestamps.',
          user: JSON.stringify({ facts, factCodes: refs }),
        }), refs);
        if (!selection) throw new Error("Invalid provider selection");
        order = selection.factCodes;
      } catch {
        status = "PARTIAL";
      }
    }
    response = renderEvidenceTriage(projection, order);
  } catch {
    status = "FAILED";
  }
  const result = response ? {
    ...response, runId, status, agentId: EVIDENCE_TRIAGE_AGENT.id,
    agentVersion: EVIDENCE_TRIAGE_AGENT.version, policyDecision: policyFor(EVIDENCE_TRIAGE_AGENT.id, "READ"),
    provider, model,
  } : null;
  await db.insert(agentRunsTable).values({
    id: runId, agentId: EVIDENCE_TRIAGE_AGENT.id, agentVersion: EVIDENCE_TRIAGE_AGENT.version,
    actorPersonId: trainerId, objective: OBJECTIVE, policyDecision: policyFor(EVIDENCE_TRIAGE_AGENT.id, "READ"),
    toolRefs: ["get_assigned_path_a_evidence_projection"], evidenceRefs: refs,
    provider, model, status,
    resultSummary: { categoryCount: response?.categories.length ?? 0, findingCount: response?.categories.reduce((sum, category) => sum + category.count, 0) ?? 0, fallbackUsed: status === "PARTIAL", advisory: true },
    resultHash: result ? resultHash(result) : null, startedAt, completedAt: new Date(),
  });
  if (!result) throw new Error("Evidence triage could not be generated");
  return result;
}