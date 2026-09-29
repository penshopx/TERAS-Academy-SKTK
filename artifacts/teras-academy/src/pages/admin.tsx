import React, { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  type AdminDiagnosticProvenanceException, type AdminModuleCatalogue, type AdminOperationalSummary, type AdminReminderEscalation,
  type AdminAgentObservability,
  getGetAdminAccessQueryKey, getGetAdminOperationalSummaryQueryKey, getGetCurrentSessionQueryKey, getListAdminAccessRequestsQueryKey, getListAdminAuditEventsQueryKey, getListAdminCohortsQueryKey, getListAdminEnrollmentsQueryKey,
  getListAdminPathwaysQueryKey, getListAdminProgramsQueryKey, getListAdminUsersQueryKey,
  getGetAdminModuleCatalogueQueryKey, useGetAdminModuleCatalogue,
  getGetAdminAgentObservabilityQueryKey, useGetAdminAgentObservability,
  useCreateAdminCohort, useCreateAdminEnrollment, useCreateAdminPathway, useCreateAdminProgram,
  useApproveAdminAccessRequest, useCreateAdminAccessRequest, useCreateAdminUser, useGetAdminAccess, useGetAdminOperationalSummary, useGetCurrentSession, useListAdminAccessRequests, useListAdminAuditEvents, useListAdminCohorts, useListAdminEnrollments,
  useListAdminPathways, useListAdminPrograms, useListAdminUsers, useReplaceAdminUserRoles,
  useUpdateAdminCohort, useUpdateAdminEnrollment, useUpdateAdminPathway, useUpdateAdminProgram,
  useUpdateAdminUser, useRejectAdminAccessRequest,
  getListAdminKnowledgeArticlesQueryKey, getListAdminKnowledgeNotFoundTopicsQueryKey, useCreateAdminKnowledgeArticle, useListAdminKnowledgeArticles, useListAdminKnowledgeNotFoundTopics, usePublishAdminKnowledgeArticle, useUpdateAdminKnowledgeArticle,
  getListAdminCompetencyFrameworksQueryKey, useListAdminCompetencyFrameworks, useCreateAdminCompetencyFramework, useCreateAdminCompetencyUnit, useUpdateAdminCompetencyUnit,
  getListAdminReadinessRulesQueryKey, useCreateAdminReadinessRuleVersion, useListAdminReadinessRules,
  getListAdminReminderEscalationsQueryKey, listAdminReminderEscalations, useResolveAdminReminderEscalation,
  useListAdminDiagnosticProvenanceExceptions,
  getListAdminDiagnosticProvenanceExceptionsQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Archive, ArrowRight, ClipboardCheck, Loader2, Plus, RefreshCw, UsersRound } from "lucide-react";
import { CompetencyUnitEditor } from "@/components/admin/CompetencyUnitEditor";
import { ReadinessAuditHistory } from "@/components/admin/ReadinessAuditHistory";

const roles = ["trainer", "assessor", "learner"] as const;
const userSchema = z.object({ name: z.string().min(1, "Nama wajib diisi"), email: z.string().email("Email tidak valid").or(z.literal("")), organization: z.string(), authProvider: z.string().min(1, "Provider autentikasi wajib diisi"), authSubject: z.string(), roles: z.array(z.enum(roles)).min(1, "Pilih minimal satu peran") });
type UserForm = z.infer<typeof userSchema>;
const queryOptions = { staleTime: 30_000, refetchOnMount: "always" as const };
export const reminderDeliveryPollingInterval = 5_000;

function hasReminderDeliveryInProgress(item: Pick<AdminReminderEscalation, "emailNotification" | "webhookNotification">) {
  return [item.emailNotification, item.webhookNotification].some(notification =>
    notification?.status === "pending" || notification?.status === "sending"
  );
}

export function getReminderDeliveryRefetchInterval(summary?: Pick<AdminOperationalSummary, "failedTrainerReminders">) {
  const hasDeliveryInProgress = summary?.failedTrainerReminders.some(hasReminderDeliveryInProgress) ?? false;
  return hasDeliveryInProgress ? reminderDeliveryPollingInterval : false;
}

export function adminErrorMessage(error: unknown) {
  const candidate = error as { status?: number; data?: { error?: string }; message?: string };
  return candidate?.status === 403 ? "Anda tidak memiliki akses admin." : candidate?.status === 409 ? "Konflik: data sudah ada atau berubah. Muat ulang lalu coba lagi." : candidate?.data?.error || candidate?.message || "Operasi tidak dapat diselesaikan.";
}
export function isAdminForbidden(error: unknown) {
  return (error as { status?: number } | undefined)?.status === 403;
}
export function isAdminMfaRequired(error: unknown) {
  const candidate = error as { status?: number; data?: { error?: string } } | undefined;
  return candidate?.status === 403 && /(?:MFA|aal2)/i.test(candidate.data?.error ?? "");
}
export function shouldEnableAdminQueries(access: { isSuccess: boolean; isFetching: boolean; data?: { authorized: boolean } }) {
  return access.isSuccess && !access.isFetching && access.data?.authorized === true;
}

type QueueFilters = { learner: string; pathway: string; trainer: string; assessor: string };
type QueueFilterKey = keyof QueueFilters;
const emptyQueueFilters: QueueFilters = { learner: "", pathway: "", trainer: "", assessor: "" };
const queueFilterKeys = Object.keys(emptyQueueFilters) as QueueFilterKey[];
type QueueId = "evidence" | "assessment" | "remediation" | "reassessment";
const isQueueId = (value: string | null): value is QueueId => ["evidence", "assessment", "remediation", "reassessment"].includes(value ?? "");

export function queueStateFromSearch(search: string) {
  const params = new URLSearchParams(search);
  const queue = params.get("queue");
  return {
    selectedQueue: isQueueId(queue) ? queue : null,
    filters: Object.fromEntries(queueFilterKeys.map(key => [key, params.get(key) ?? ""])) as QueueFilters,
  };
}

export function filterQueueItems<T extends { learnerId: string; pathwayId: string; trainerId: string | null; assessorId: string | null }>(items: T[], filters: QueueFilters) {
  return items.filter(item =>
    (!filters.learner || item.learnerId === filters.learner)
    && (!filters.pathway || item.pathwayId === filters.pathway)
    && (!filters.trainer || (filters.trainer === "unassigned" ? item.trainerId === null : item.trainerId === filters.trainer))
    && (!filters.assessor || (filters.assessor === "unassigned" ? item.assessorId === null : item.assessorId === filters.assessor))
  );
}

export function validateQueueFilters<T extends { learnerId: string; pathwayId: string; trainerId: string | null; assessorId: string | null }>(items: T[], filters: QueueFilters) {
  const available = {
    learner: new Set(items.map(item => item.learnerId)),
    pathway: new Set(items.map(item => item.pathwayId)),
    trainer: new Set(items.map(item => item.trainerId ?? "unassigned")),
    assessor: new Set(items.map(item => item.assessorId ?? "unassigned")),
  };
  return Object.fromEntries(queueFilterKeys.map(key => [key, !filters[key] || available[key].has(filters[key]) ? filters[key] : ""])) as QueueFilters;
}

const auditEntityLabels: Record<string, string> = {
  user: "pengguna",
  program: "program",
  pathway: "pathway",
  cohort: "cohort",
  enrollment: "enrollment",
  knowledge: "artikel knowledge",
};

function auditDescription(action: string, entityType: string) {
  if (action === "delivery_blocked" && entityType === "trainer_reminder_preference") return "Pengiriman pengingat ditahan: zona waktu trainer tidak valid";
  if (action === "delivery_configuration_recovered" && entityType === "trainer_reminder_preference") return "Zona waktu trainer sudah diperbaiki";
  const entity = auditEntityLabels[entityType] ?? "data";
  if (action === "create") return `${entity[0].toUpperCase()}${entity.slice(1)} baru dibuat`;
  if (action === "update") return `Informasi ${entity} diperbarui`;
  if (action === "replace_roles") return "Peran dan hak akses pengguna diperbarui";
  if (action === "publish") return `${entity[0].toUpperCase()}${entity.slice(1)} dipublikasikan`;
  return `Perubahan pada ${entity}`;
}

function auditTime(value: string | Date) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
function State({ loading, error, empty, children }: { loading: boolean; error: unknown; empty: boolean; children: ReactNode }) {
  if (loading) return <div className="flex min-h-32 items-center gap-2 text-muted-foreground" role="status" aria-live="polite"><Loader2 className="h-4 w-4 animate-spin" /> Memuat data operasional…</div>;
  if (error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{adminErrorMessage(error)}</div>;
  if (empty) return <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Belum ada data. Tambahkan catatan pertama di atas.</div>;
  return <>{children}</>;
}

function ModuleCatalogue({ catalogue }: { catalogue: ReturnType<typeof useGetAdminModuleCatalogue<AdminModuleCatalogue>> }) {
  const incompleteCount = catalogue.data?.legacyModules.filter(module => module.mappingStatus !== "mapped").length ?? 0;
  return <Card data-testid="admin-module-catalogue">
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Katalog modul dan referensi legacy</CardTitle>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">M01–M10 adalah baseline canonical aktif. B01–B08 hanya ditampilkan sebagai histori read-only untuk audit dan penyelesaian referensi lama; catatan ini bukan kurikulum aktif.</p>
        </div>
        <Badge variant={incompleteCount ? "destructive" : "outline"}>{incompleteCount ? `${incompleteCount} mapping perlu ditinjau` : "Semua mapping lengkap"}</Badge>
      </div>
    </CardHeader>
    <CardContent>
      <State loading={catalogue.isLoading} error={catalogue.error} empty={!catalogue.data}>
        <section aria-labelledby="canonical-modules-title">
          <h3 id="canonical-modules-title" className="font-semibold">Baseline canonical aktif</h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {catalogue.data?.canonicalModules.map(module => <div key={module.id} className="rounded-md border border-primary/20 bg-primary/5 p-3" data-testid={`canonical-module-${module.code}`}>
              <div className="flex items-center justify-between gap-2"><strong className="font-mono text-primary">{module.code}</strong><Badge>{module.status}</Badge></div>
              <p className="mt-2 text-sm font-medium">{module.name}</p>
            </div>)}
          </div>
        </section>
        <section className="mt-6 border-t pt-6" aria-labelledby="legacy-modules-title">
          <h3 id="legacy-modules-title" className="font-semibold">Catatan legacy yang dihentikan</h3>
          <p className="mt-1 text-sm text-muted-foreground">Mapping di bawah tidak dapat diubah dari halaman ini.</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {catalogue.data?.legacyModules.map(module => {
              const complete = module.mappingStatus === "mapped";
              return <div key={module.legacyCode} className="rounded-md border p-4" data-testid={`legacy-module-${module.legacyCode}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-mono">{module.legacyCode}</strong>
                  <Badge variant="secondary">{module.retiredStatus}</Badge>
                  <Badge variant={complete ? "outline" : "destructive"}>{complete ? "mapped" : module.mappingStatus === "missing" ? "mapping hilang" : "mapping tidak lengkap"}</Badge>
                </div>
                <p className="mt-2 text-sm font-medium">{module.legacyName ?? "Nama modul legacy tidak tersedia"}</p>
                <div className="mt-3 flex items-center gap-2 rounded bg-muted/50 p-3 text-sm">
                  <span className="font-mono text-muted-foreground">{module.legacyCode}</span><ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {module.targetCode ? <span><strong className="font-mono text-primary">{module.targetCode}</strong> · {module.targetName ?? "Nama target tidak tersedia"}</span> : <span className="font-medium text-destructive">Target canonical tidak tersedia</span>}
                </div>
                {module.note && <p className="mt-2 text-xs text-muted-foreground">{module.note}</p>}
              </div>;
            })}
          </div>
        </section>
      </State>
    </CardContent>
  </Card>;
}

const diagnosticEntityLabels: Record<string, string> = {
  profile: "Profil diagnostik",
  profile_item: "Item profil",
  gap: "Gap diagnostik",
};

function DiagnosticProvenanceExceptions({ query }: { query: {
  data?: AdminDiagnosticProvenanceException[];
  isLoading: boolean;
  error: unknown;
} }) {
  return <Card data-testid="admin-diagnostic-provenance-exceptions">
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Pengecualian sumber diagnostik lama</CardTitle>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Record read-only yang belum dapat dipetakan ke sumber respons diagnostik lengkap. Gunakan identitas di bawah untuk investigasi dan perbaikan data.</p>
        </div>
        <Badge variant={query.data?.length ? "destructive" : "outline"}>{query.data?.length ?? 0} perlu ditinjau</Badge>
      </div>
    </CardHeader>
    <CardContent>
      <State loading={query.isLoading} error={query.error} empty={!query.data?.length}>
        <div className="space-y-3">
          {query.data?.map(item => <article key={`${item.entityType}:${item.entityId}`} className="rounded-md border p-4" data-testid={`row-provenance-exception-${item.entityType}-${item.entityId}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{diagnosticEntityLabels[item.entityType] ?? item.entityType}</Badge><span className="font-mono text-xs text-muted-foreground">{item.entityId}</span></div>
              <time className="text-xs text-muted-foreground" dateTime={String(item.detectedAt)}>{auditTime(item.detectedAt)}</time>
            </div>
            <p className="mt-3 text-sm font-medium">{item.reason}</p>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">Session</dt><dd className="mt-1 break-all font-mono">{item.sessionId ?? "Tidak ditemukan"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Unit kompetensi</dt><dd className="mt-1 break-all font-mono">{item.competencyUnitId ?? "Tidak ditemukan"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Profil</dt><dd className="mt-1 break-all font-mono">{item.profileId ?? "Tidak ditemukan"}</dd></div>
            </dl>
          </article>)}
        </div>
      </State>
    </CardContent>
  </Card>;
}

export default function Admin() {
  const client = useQueryClient(); const { toast } = useToast();
  const [tab, setTab] = useState<AdminTab>("summary");
  const [selectedQueue, setSelectedQueue] = useState<QueueId | null>(() => queueStateFromSearch(window.location.search).selectedQueue);
  const [queueFilters, setQueueFilters] = useState<QueueFilters>(() => queueStateFromSearch(window.location.search).filters);
  const [confirm, setConfirm] = useState<{ kind: "user" | "program" | "pathway" | "cohort" | "enrollment"; id: string; label: string } | null>(null);
  const [editing, setEditing] = useState<{ kind: "user" | "program" | "pathway" | "cohort" | "enrollment" | "knowledge"; item: Record<string, unknown> } | null>(null);
  const access = useGetAdminAccess({ query: { ...queryOptions, queryKey: getGetAdminAccessQueryKey(), retry: false } });
  const session = useGetCurrentSession({ query: { ...queryOptions, queryKey: getGetCurrentSessionQueryKey(), retry: false } });
  const isSuperAdmin = session.data?.roles.some(role => role === "super_admin" || role === "admin") === true;
  const adminQueriesEnabled = shouldEnableAdminQueries(access);
  const assignableRoles = roles;
  const users = useListAdminUsers({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminUsersQueryKey() } });
  const programs = useListAdminPrograms({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminProgramsQueryKey() } });
  const moduleCatalogue = useGetAdminModuleCatalogue<AdminModuleCatalogue>({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getGetAdminModuleCatalogueQueryKey() } });
  const pathways = useListAdminPathways({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminPathwaysQueryKey() } });
  const cohorts = useListAdminCohorts({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminCohortsQueryKey() } });
  const enrollments = useListAdminEnrollments({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminEnrollmentsQueryKey() } });
  const audit = useListAdminAuditEvents({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminAuditEventsQueryKey() } });
  const timeZoneRecoveries = new Map(audit.data?.flatMap(event => {
    if (event.action !== "delivery_configuration_recovered"
      || event.entityType !== "trainer_reminder_preference"
      || !event.after || typeof event.after !== "object"
      || !("incidentId" in event.after) || typeof event.after.incidentId !== "string") return [];
    return [[event.after.incidentId, event] as const];
  }) ?? []);
  const accessRequests = useListAdminAccessRequests({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminAccessRequestsQueryKey() } });
  const knowledge = useListAdminKnowledgeArticles({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminKnowledgeArticlesQueryKey() } });
  const unansweredTopics = useListAdminKnowledgeNotFoundTopics({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminKnowledgeNotFoundTopicsQueryKey() } });
  const competencies = useListAdminCompetencyFrameworks({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminCompetencyFrameworksQueryKey() } });
  const readinessRules = useListAdminReadinessRules({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminReadinessRulesQueryKey() } });
  const provenanceExceptions = useListAdminDiagnosticProvenanceExceptions({ query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getListAdminDiagnosticProvenanceExceptionsQueryKey() } });
  const summary = useGetAdminOperationalSummary<AdminOperationalSummary>({
    query: {
      ...queryOptions,
      enabled: adminQueriesEnabled,
      queryKey: getGetAdminOperationalSummaryQueryKey(),
      refetchInterval: query => getReminderDeliveryRefetchInterval(query.state.data),
    },
  });
  const [agentHealthCursor, setAgentHealthCursor] = useState<string | null>(null);
  const [agentHealthHistory, setAgentHealthHistory] = useState<string[]>([]);
  const observability = useGetAdminAgentObservability<AdminAgentObservability>(agentHealthCursor ? { cursor: agentHealthCursor } : undefined, {
    query: { ...queryOptions, enabled: adminQueriesEnabled, queryKey: getGetAdminAgentObservabilityQueryKey(agentHealthCursor ? { cursor: agentHealthCursor } : undefined) },
  });
  const createUser = useCreateAdminUser(); const rolesMutation = useReplaceAdminUserRoles(); const updateUser = useUpdateAdminUser();
  const createAccessRequest = useCreateAdminAccessRequest();
  const approveRequest = useApproveAdminAccessRequest(); const rejectRequest = useRejectAdminAccessRequest();
  const createProgram = useCreateAdminProgram(); const updateProgram = useUpdateAdminProgram();
  const createPathway = useCreateAdminPathway(); const updatePathway = useUpdateAdminPathway();
  const createCohort = useCreateAdminCohort(); const updateCohort = useUpdateAdminCohort();
  const createEnrollment = useCreateAdminEnrollment(); const updateEnrollment = useUpdateAdminEnrollment();
  const createKnowledge = useCreateAdminKnowledgeArticle(); const publishKnowledge = usePublishAdminKnowledgeArticle();
  const updateKnowledge = useUpdateAdminKnowledgeArticle();
  const createCompetency = useCreateAdminCompetencyFramework();
  const createCompetencyUnit = useCreateAdminCompetencyUnit();
  const updateCompetencyUnit = useUpdateAdminCompetencyUnit();
  const createReadinessRule = useCreateAdminReadinessRuleVersion();
  useEffect(() => {
    const restoreQueueState = () => {
      const restored = queueStateFromSearch(window.location.search);
      setTab("summary");
      setSelectedQueue(restored.selectedQueue);
      setQueueFilters(restored.filters);
    };
    window.addEventListener("popstate", restoreQueueState);
    return () => window.removeEventListener("popstate", restoreQueueState);
  }, []);
  useEffect(() => {
    const activeQueue = summary.data?.queues.find(queue => queue.id === selectedQueue);
    if (!activeQueue) return;
    const validated = validateQueueFilters(activeQueue.items, queueFilters);
    const invalidKeys = queueFilterKeys.filter(key => validated[key] !== queueFilters[key]);
    if (!invalidKeys.length) return;
    setQueueFilters(validated);
    const url = new URL(window.location.href);
    invalidKeys.forEach(key => url.searchParams.delete(key));
    window.history.replaceState({}, "", url);
  }, [queueFilters, selectedQueue, summary.data]);
  const invalidate = (...keys: ReadonlyArray<readonly unknown[]>) => Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
  const saved = (message: string) => toast({ title: "Tersimpan", description: message });
  const form = useForm<UserForm>({ resolver: zodResolver(userSchema), defaultValues: { name: "", email: "", organization: "", authProvider: "supabase", authSubject: "", roles: ["learner"] } });
  const submitUser = (v: UserForm) => createUser.mutate({ data: { id: crypto.randomUUID(), name: v.name, initials: v.name.split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase(), email: v.email || null, organization: v.organization || null, authProvider: v.authProvider, authSubject: v.authSubject || null, status: "active", roles: v.roles } }, {
    onSuccess: async (user) => { await rolesMutation.mutateAsync({ personId: user.id, data: { roles: v.roles } }); await invalidate(getListAdminUsersQueryKey(), getListAdminAuditEventsQueryKey()); form.reset(); saved("Pengguna dan peran diperbarui."); },
    onError: e => toast({ variant: "destructive", title: "Gagal membuat pengguna", description: adminErrorMessage(e) }),
  });
  const archive = () => {
    if (!confirm) return; const c = confirm;
    const finish = () => { setConfirm(null); saved(`${c.label} diperbarui.`); invalidate(getListAdminUsersQueryKey(), getListAdminProgramsQueryKey(), getListAdminPathwaysQueryKey(), getListAdminCohortsQueryKey(), getListAdminAuditEventsQueryKey()); };
    if (c.kind === "user") updateUser.mutate({ personId: c.id, data: { status: "inactive" } }, { onSuccess: finish, onError: e => toast({ variant: "destructive", title: "Gagal menonaktifkan", description: adminErrorMessage(e) }) });
    else if (c.kind === "program") updateProgram.mutate({ programId: c.id, data: { status: "archived" } }, { onSuccess: finish, onError: e => toast({ variant: "destructive", title: "Gagal mengarsipkan", description: adminErrorMessage(e) }) });
    else if (c.kind === "pathway") updatePathway.mutate({ pathwayId: c.id, data: { status: "archived" } }, { onSuccess: finish, onError: e => toast({ variant: "destructive", title: "Gagal mengarsipkan", description: adminErrorMessage(e) }) });
    else if (c.kind === "cohort") updateCohort.mutate({ cohortId: c.id, data: { status: "archived" } }, { onSuccess: finish, onError: e => toast({ variant: "destructive", title: "Gagal mengarsipkan", description: adminErrorMessage(e) }) });
    else updateEnrollment.mutate({ enrollmentId: c.id, data: { status: "inactive" } }, { onSuccess: finish, onError: e => toast({ variant: "destructive", title: "Gagal menonaktifkan", description: adminErrorMessage(e) }) });
  };
  const quickCreate = (event: React.FormEvent<HTMLFormElement>, kind: string) => {
    event.preventDefault(); const target = event.currentTarget; const v = Object.fromEntries(new FormData(target)); const id = crypto.randomUUID();
    const ok = () => { target.reset(); saved(`${kind} ditambahkan.`); invalidate(getListAdminProgramsQueryKey(), getListAdminPathwaysQueryKey(), getListAdminCohortsQueryKey(), getListAdminEnrollmentsQueryKey(), getListAdminAuditEventsQueryKey()); };
    const fail = (e: unknown) => toast({ variant: "destructive", title: `Gagal menambah ${kind}`, description: adminErrorMessage(e) });
    if (kind === "program") createProgram.mutate({ data: { id, name: String(v.name), domain: String(v.domain), description: String(v.description), status: "active" } }, { onSuccess: ok, onError: fail });
    if (kind === "pathway") createPathway.mutate({ data: { id, programId: String(v.programId), name: String(v.name), type: String(v.type), outcome: String(v.outcome), status: "active" } }, { onSuccess: ok, onError: fail });
    if (kind === "cohort") createCohort.mutate({ data: { id, programId: String(v.programId), name: String(v.name), startsOn: String(v.startsOn) || null, endsOn: String(v.endsOn) || null, status: "active" } }, { onSuccess: ok, onError: fail });
    if (kind === "enrollment") createEnrollment.mutate({ data: { id, learnerId: String(v.learnerId), programId: String(v.programId), pathwayId: String(v.pathwayId), trainerId: String(v.trainerId) || null, assessorId: String(v.assessorId) || null, cohortId: String(v.cohortId) || null, status: "active" } }, { onSuccess: ok, onError: fail });
  };
  const value = (name: string) => String(editing?.item[name] ?? "");
  const saveEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const target = event.currentTarget;
    const values = new FormData(target);
    const id = value("id");
    const done = () => { setEditing(null); saved("Perubahan diperbarui."); invalidate(getListAdminUsersQueryKey(), getListAdminProgramsQueryKey(), getListAdminPathwaysQueryKey(), getListAdminCohortsQueryKey(), getListAdminEnrollmentsQueryKey(), getListAdminAuditEventsQueryKey()); };
    const failed = (error: unknown) => toast({ variant: "destructive", title: "Gagal menyimpan perubahan", description: adminErrorMessage(error) });
    if (editing.kind === "user") {
      const selectedRoles = values.getAll("roles") as Array<"admin" | "trainer" | "assessor" | "learner">;
      if (!selectedRoles.length) { toast({ variant: "destructive", title: "Peran diperlukan", description: "Pilih minimal satu peran." }); return; }
      updateUser.mutate({ personId: id, data: { name: String(values.get("name")), initials: String(values.get("name")).split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase(), email: String(values.get("email")) || null, organization: String(values.get("organization")) || null, authProvider: String(values.get("authProvider")), authSubject: String(values.get("authSubject")) || null, status: values.get("status") as "active" | "inactive" } }, { onSuccess: async () => { await rolesMutation.mutateAsync({ personId: id, data: { roles: selectedRoles } }); done(); }, onError: failed });
    } else if (editing.kind === "program") updateProgram.mutate({ programId: id, data: { name: String(values.get("name")), domain: String(values.get("domain")), description: String(values.get("description")), status: values.get("status") as "active" | "archived" } }, { onSuccess: done, onError: failed });
    else if (editing.kind === "pathway") updatePathway.mutate({ pathwayId: id, data: { name: String(values.get("name")), type: String(values.get("type")), outcome: String(values.get("outcome")), status: values.get("status") as "active" | "archived" } }, { onSuccess: done, onError: failed });
    else if (editing.kind === "cohort") updateCohort.mutate({ cohortId: id, data: { name: String(values.get("name")), startsOn: String(values.get("startsOn")) || null, endsOn: String(values.get("endsOn")) || null, status: values.get("status") as "active" | "archived" } }, { onSuccess: done, onError: failed });
    else if (editing.kind === "knowledge") {
      const audience = values.getAll("audience") as Array<"learner" | "trainer" | "assessor" | "admin">;
      if (!audience.length) { toast({ variant: "destructive", title: "Audiens diperlukan", description: "Pilih minimal satu peran yang dapat melihat artikel." }); return; }
      updateKnowledge.mutate({ articleId: id, data: { title: String(values.get("title")), body: String(values.get("body")), category: values.get("category") as "help" | "energy", audience } }, { onSuccess: () => { invalidate(getListAdminKnowledgeArticlesQueryKey(), getListAdminAuditEventsQueryKey()); done(); }, onError: failed });
    }
    else updateEnrollment.mutate({ enrollmentId: id, data: { pathwayId: String(values.get("pathwayId")), trainerId: String(values.get("trainerId")) || null, assessorId: String(values.get("assessorId")) || null, cohortId: String(values.get("cohortId")) || null, status: values.get("status") as "active" | "inactive" | "completed" } }, { onSuccess: done, onError: failed });
  };
  const createArticle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const audience = values.getAll("audience") as Array<"learner" | "trainer" | "assessor" | "admin">;
    if (!audience.length) {
      toast({ variant: "destructive", title: "Audiens diperlukan", description: "Pilih minimal satu peran yang dapat melihat artikel." });
      return;
    }
    createKnowledge.mutate({ data: { id: crypto.randomUUID(), category: values.get("category") as "help" | "energy", title: String(values.get("title")), body: String(values.get("body")), audience } }, { onSuccess: () => { form.reset(); invalidate(getListAdminKnowledgeArticlesQueryKey(), getListAdminAuditEventsQueryKey()); saved("Artikel disimpan sebagai draft."); }, onError: error => toast({ variant: "destructive", title: "Gagal menyimpan artikel", description: adminErrorMessage(error) }) });
  };
  const createRule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const values = new FormData(formElement);
    const pathway = pathways.data?.find(item => item.id === values.get("pathwayId"));
    if (!pathway) return;
    createReadinessRule.mutate({ data: {
      programId: pathway.programId,
      pathwayId: pathway.id,
      sequence: Number(values.get("sequence")),
      code: String(values.get("code")),
      name: String(values.get("name")),
      requirement: String(values.get("requirement")),
      assessmentMode: values.get("assessmentMode") as "All" | "Mapped" | "None",
      evidenceMode: values.get("evidenceMode") as "All" | "Mapped" | "None",
      competencyUnitId: String(values.get("competencyUnitId")) || null,
      threshold: Number(values.get("threshold")),
      hardGate: values.get("hardGate") === "on",
    } }, {
      onSuccess: () => { formElement.reset(); invalidate(getListAdminReadinessRulesQueryKey(), getListAdminAuditEventsQueryKey()); saved("Versi aturan readiness baru dipublikasikan."); },
      onError: error => toast({ variant: "destructive", title: "Gagal menerbitkan aturan", description: adminErrorMessage(error) }),
    });
  };
  const tabs = [["summary", "Ringkasan"], ["users", "Pengguna"], ["programs", "Program"], ["pathways", "Pathway"], ["cohorts", "Cohort"], ["enrollments", "Enrollment"], ["knowledge", "Knowledge"], ["competencies", "Kompetensi"], ["readiness", "Readiness"], ["readinessAudit", "Riwayat Readiness"], ["diagnosticExceptions", "Sumber Diagnostik"], ["audit", "Audit"]] as const;
  const openTab = (nextTab: AdminTab) => {
    setTab(nextTab);
    if (nextTab !== "summary") {
      setSelectedQueue(null);
      setQueueFilters(emptyQueueFilters);
      const url = new URL(window.location.href);
      url.searchParams.delete("queue");
      queueFilterKeys.forEach(key => url.searchParams.delete(key));
      window.history.replaceState({}, "", url);
    }
  };
  const openQueue = (queueId: QueueId) => {
    setTab("summary");
    setSelectedQueue(queueId);
    setQueueFilters(emptyQueueFilters);
    const url = new URL(window.location.href);
    url.searchParams.set("queue", queueId);
    queueFilterKeys.forEach(key => url.searchParams.delete(key));
    window.history.pushState({}, "", url);
  };
  const updateQueueFilter = (key: QueueFilterKey, value: string) => {
    setQueueFilters(current => ({ ...current, [key]: value }));
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.replaceState({}, "", url);
  };
  const field = (name: string, placeholder: string, required = true) => <Input name={name} required={required} placeholder={placeholder} data-testid={`input-admin-${name}`} />;
  if (access.isLoading) return <div className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground" role="status" aria-live="polite" data-testid="admin-access-loading"><Loader2 className="h-4 w-4 animate-spin" /> Memeriksa akses admin…</div>;
  if (isAdminMfaRequired(access.error)) return <div className="flex min-h-48 items-center justify-center" role="alert" aria-live="assertive" data-testid="admin-mfa-required"><Card className="max-w-md border-amber-500/40"><CardContent className="p-6 text-center"><h1 className="font-semibold">Verifikasi MFA diperlukan</h1><p className="mt-2 text-sm text-muted-foreground">Role Super Admin Anda tetap aktif. Tingkatkan sesi ke AAL2 sebelum membuka dashboard.</p><a className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 font-bold text-primary-foreground" href={`${import.meta.env.BASE_URL}security`}>Buka Security &amp; MFA</a></CardContent></Card></div>;
  if (isAdminForbidden(access.error)) return <div className="flex min-h-48 items-center justify-center" role="alert" aria-live="assertive" data-testid="admin-access-denied"><Card className="max-w-md border-destructive/40"><CardContent className="p-6 text-center"><h1 className="font-semibold">Anda tidak memiliki akses admin</h1><p className="mt-2 text-sm text-muted-foreground">Akses dashboard ini ditentukan oleh server. Hubungi administrator jika Anda memerlukan peran admin.</p></CardContent></Card></div>;
  if (access.error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert" data-testid="admin-access-error">{adminErrorMessage(access.error)}</div>;
  return <div className="space-y-6" aria-labelledby="admin-title">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-mono text-xs font-bold tracking-widest text-primary">OPERATIONS · SERVER-AUTHORIZED</p><h1 id="admin-title" className="mt-2 text-3xl font-bold">Admin Control Room</h1><p className="mt-1 text-sm text-muted-foreground">Visibilitas UI bukan otorisasi; setiap aksi diverifikasi oleh server.</p></div><Button variant="outline" onClick={() => client.invalidateQueries()} data-testid="button-refresh-admin"><RefreshCw className="mr-2 h-4 w-4" />Muat ulang</Button></header>
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Bagian administrasi">{tabs.map(([id, label]) => <Button key={id} role="tab" aria-selected={tab === id} variant={tab === id ? "default" : "outline"} onClick={() => openTab(id)} data-testid={`button-admin-tab-${id}`}>{label}</Button>)}</div>
     {tab === "summary" && <OperationalSummary summary={summary} observability={observability} selectedQueue={selectedQueue} filters={queueFilters} onFilterChange={updateQueueFilter} onOpenQueue={openQueue} onOpenTab={openTab} onOlderAgentHealth={() => { if (observability.data?.nextCursor) { setAgentHealthHistory(previous => [...previous, agentHealthCursor ?? ""]); setAgentHealthCursor(observability.data.nextCursor); } }} onNewerAgentHealth={() => { setAgentHealthCursor(agentHealthHistory.at(-1) || null); setAgentHealthHistory(previous => previous.slice(0, -1)); }} agentHealthPage={agentHealthHistory.length + 1} />}
    {tab === "users" && <><Card><CardHeader><CardTitle>Ajukan promosi admin</CardTitle></CardHeader><CardContent><form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); createAccessRequest.mutate({ data: { targetPersonId: String(values.get("targetPersonId")), requestedRole: "admin", reason: String(values.get("reason")) } }, { onSuccess: () => { event.currentTarget.reset(); saved("Permintaan promosi admin dikirim."); } }); }}><select name="targetPersonId" required className="h-10 rounded-md border bg-background px-3"><option value="">Pilih pengguna</option>{users.data?.filter(user => !user.roles.includes("admin") && !user.roles.includes("super_admin")).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select><Input name="reason" required placeholder="Alasan promosi" /><Button type="submit" disabled={createAccessRequest.isPending}>Ajukan</Button></form></CardContent></Card>{isSuperAdmin && <Card><CardHeader><CardTitle>Persetujuan akses administratif</CardTitle></CardHeader><CardContent><State loading={accessRequests.isLoading} error={accessRequests.error} empty={!accessRequests.data?.filter(request => request.status === "pending").length}>{accessRequests.data?.filter(request => request.status === "pending").map(request => <div key={request.id} className="flex items-center justify-between border-b py-3 text-sm"><span>Target {request.targetPersonId} meminta <strong>{request.requestedRole}</strong>{request.reason ? ` · ${request.reason}` : ""}</span><span className="flex gap-2"><Button size="sm" onClick={() => approveRequest.mutate({ requestId: request.id }, { onSuccess: () => invalidate(getListAdminAccessRequestsQueryKey(), getListAdminUsersQueryKey(), getListAdminAuditEventsQueryKey()) })}>Setujui</Button><Button size="sm" variant="outline" onClick={() => rejectRequest.mutate({ requestId: request.id }, { onSuccess: () => invalidate(getListAdminAccessRequestsQueryKey(), getListAdminAuditEventsQueryKey()) })}>Tolak</Button></span></div>)}</State></CardContent></Card>}<Card><CardHeader><CardTitle className="flex items-center gap-2"><Plus className="h-4 w-4" />Tambah pengguna</CardTitle></CardHeader><CardContent><Form {...form}><form onSubmit={form.handleSubmit(submitUser)} className="grid gap-4 md:grid-cols-6"><FormField control={form.control} name="name" render={({ field }) => <FormItem><FormLabel>Nama</FormLabel><FormControl><Input {...field} data-testid="input-admin-user-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="email" render={({ field }) => <FormItem><FormLabel>Email</FormLabel><FormControl><Input {...field} type="email" data-testid="input-admin-user-email" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="organization" render={({ field }) => <FormItem><FormLabel>Organisasi</FormLabel><FormControl><Input {...field} data-testid="input-admin-user-organization" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="authProvider" render={({ field }) => <FormItem><FormLabel>Provider autentikasi</FormLabel><FormControl><Input {...field} data-testid="input-admin-user-auth-provider" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="authSubject" render={({ field }) => <FormItem><FormLabel>Subject autentikasi</FormLabel><FormControl><Input {...field} data-testid="input-admin-user-auth-subject" /></FormControl><p className="text-xs text-muted-foreground">Subject dari provider untuk binding identitas, bukan credential.</p><FormMessage /></FormItem>} /><div><label className="text-sm font-medium">Peran</label><div className="mt-2 flex flex-wrap gap-3">{assignableRoles.map(role => <FormField key={role} control={form.control} name="roles" render={({ field }) => <label className="flex items-center gap-1 text-sm"><Checkbox checked={field.value.includes(role)} onCheckedChange={checked => field.onChange(checked ? [...field.value, role] : field.value.filter(x => x !== role))} data-testid={`checkbox-role-${role}`} />{role}</label>} />)}</div>{form.formState.errors.roles?.message && <p className="mt-1 text-sm text-destructive" role="alert">{form.formState.errors.roles.message}</p>}</div><Button type="submit" disabled={createUser.isPending || rolesMutation.isPending} data-testid="button-create-user">{createUser.isPending ? <Loader2 className="animate-spin" /> : "Simpan pengguna"}</Button></form></Form></CardContent></Card><State loading={users.isLoading} error={users.error} empty={!users.data?.length}><div className="grid gap-3">{users.data?.filter(u => isSuperAdmin || !u.roles.some(r => r === "admin" || r === "super_admin")).map(u => <Card key={u.id} data-testid={`row-admin-user-${u.id}`}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><strong>{u.name}</strong><p className="text-sm text-muted-foreground">{u.email || "Tanpa email"} · {u.organization || "—"}</p></div><div className="flex items-center gap-2"><Badge variant={u.status === "active" ? "default" : "secondary"}>{u.status}</Badge>{u.roles.map(r => <Badge key={r} variant="outline">{r}</Badge>)}<Button size="sm" variant="outline" onClick={() => setEditing({ kind: "user", item: { ...u } })} data-testid={`button-edit-user-${u.id}`}>Edit</Button><Button size="sm" variant="outline" disabled={u.status === "inactive"} onClick={() => setConfirm({ kind: "user", id: u.id, label: u.name })} data-testid={`button-deactivate-user-${u.id}`}>Nonaktifkan</Button></div></CardContent></Card>)}</div></State></>}
    {tab === "programs" && <><EntitySection title="Program baru" onSubmit={e => quickCreate(e, "program")} fields={[field("name", "Nama program"), field("domain", "Domain"), field("description", "Deskripsi")]} loading={programs.isLoading} error={programs.error} items={programs.data?.map(x => ({ ...x, detail: `${x.domain} · ${x.description}`, kind: "program" as const }))} onEdit={x => setEditing({ kind: "program", item: x })} onArchive={x => setConfirm({ kind: "program", id: x.id, label: x.name })} /><ModuleCatalogue catalogue={moduleCatalogue} /></>}
    {tab === "pathways" && <EntitySection title="Pathway baru" onSubmit={e => quickCreate(e, "pathway")} fields={[field("programId", "ID program"), field("name", "Nama"), field("type", "Tipe"), field("outcome", "Outcome")]} loading={pathways.isLoading} error={pathways.error} items={pathways.data?.map(x => ({ ...x, detail: `${x.type} · ${x.outcome}`, kind: "pathway" as const }))} onEdit={x => setEditing({ kind: "pathway", item: x })} onArchive={x => setConfirm({ kind: "pathway", id: x.id, label: x.name })} />}
    {tab === "cohorts" && <EntitySection title="Cohort baru" onSubmit={e => quickCreate(e, "cohort")} fields={[field("programId", "ID program"), field("name", "Nama cohort"), <Input key="startsOn" name="startsOn" type="date" data-testid="input-admin-startsOn" />, <Input key="endsOn" name="endsOn" type="date" data-testid="input-admin-endsOn" />]} loading={cohorts.isLoading} error={cohorts.error} items={cohorts.data?.map(x => ({ ...x, detail: `${x.startsOn || "—"} sampai ${x.endsOn || "—"}`, kind: "cohort" as const }))} onEdit={x => setEditing({ kind: "cohort", item: x })} onArchive={x => setConfirm({ kind: "cohort", id: x.id, label: x.name })} />}
    {tab === "enrollments" && <><EntitySection title="Enrollment baru" onSubmit={e => quickCreate(e, "enrollment")} fields={["learnerId", "programId", "pathwayId", "trainerId", "assessorId", "cohortId"].map(n => field(n, `ID ${n.replace("Id", "")}`, ["trainerId", "assessorId", "cohortId"].includes(n) === false))} loading={enrollments.isLoading} error={enrollments.error} items={enrollments.data?.map(x => ({ ...x, name: x.learnerId, detail: `Program ${x.programId} · Pathway ${x.pathwayId}`, kind: "enrollment" as const }))} onEdit={x => setEditing({ kind: "enrollment", item: x })} onArchive={x => setConfirm({ kind: "enrollment", id: x.id, label: x.name })} /></>}
    {tab === "knowledge" && <><Card data-testid="card-unanswered-knowledge-topics"><CardHeader><CardTitle>Topik yang belum terjawab</CardTitle><p className="text-sm text-muted-foreground">Hanya topik anonim yang dinormalisasi dan jumlah kemunculannya yang disimpan. Data kedaluwarsa otomatis setelah {unansweredTopics.data?.retentionDays ?? 90} hari.</p></CardHeader><CardContent><State loading={unansweredTopics.isLoading} error={unansweredTopics.error} empty={!unansweredTopics.data?.topics.length}><div className="grid gap-6 md:grid-cols-2">{(["help", "energy"] as const).map(category => <section key={category} aria-labelledby={`unanswered-${category}`}><h3 id={`unanswered-${category}`} className="mb-3 font-semibold">{category === "help" ? "Help Desk" : "TERAS & Energi"}</h3><div className="space-y-2">{unansweredTopics.data?.topics.filter(topic => topic.category === category).map((topic, index) => <div key={`${category}-${topic.topic}`} className="flex items-start justify-between gap-3 rounded-md border p-3" data-testid={`row-unanswered-${category}-${index}`}><div><p className="font-medium" data-testid={`text-unanswered-topic-${category}-${index}`}>{topic.topic}</p><p className="text-xs text-muted-foreground">Terakhir muncul {auditTime(topic.lastSeenAt)}</p></div><Badge variant="secondary" data-testid={`count-unanswered-topic-${category}-${index}`}>{topic.count}×</Badge></div>)}</div></section>)}</div></State></CardContent></Card><Card><CardHeader><CardTitle>Artikel knowledge baru</CardTitle></CardHeader><CardContent><form onSubmit={createArticle} className="grid gap-3"><select name="category" className="h-10 rounded-md border bg-background px-3" defaultValue="help"><option value="help">Help Desk</option><option value="energy">TERAS & Energi</option></select><Input name="title" required placeholder="Judul artikel" /><textarea name="body" required placeholder="Isi panduan terkurasi" className="min-h-28 rounded-md border bg-background p-3 text-sm" /><AudienceSelector /><Button type="submit" disabled={createKnowledge.isPending}>Simpan draft</Button></form></CardContent></Card><State loading={knowledge.isLoading} error={knowledge.error} empty={!knowledge.data?.length}><div className="grid gap-3">{knowledge.data?.map(article => <Card key={article.id}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><strong>{article.title}</strong><p className="text-sm text-muted-foreground">{article.category} · v{article.version} · {article.status} · {article.audience.join(", ")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={article.status === "archived"} onClick={() => setEditing({ kind: "knowledge", item: { ...article } })}>Edit</Button><Button size="sm" disabled={article.status !== "draft" || publishKnowledge.isPending} onClick={() => publishKnowledge.mutate({ articleId: article.id }, { onSuccess: () => { invalidate(getListAdminKnowledgeArticlesQueryKey(), getListAdminAuditEventsQueryKey()); saved("Artikel diterbitkan."); }, onError: error => toast({ variant: "destructive", title: "Gagal menerbitkan", description: adminErrorMessage(error) }) })}>Terbitkan</Button></div></CardContent></Card>)}</div></State></>}
    {tab === "competencies" && <Card><CardHeader><CardTitle>Framework kompetensi</CardTitle><p className="text-sm text-muted-foreground">Internal simulation/preparation is not an official assessment or certification.</p></CardHeader><CardContent><form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); const formElement = event.currentTarget; const values = new FormData(formElement); createCompetency.mutate({ data: { id: crypto.randomUUID(), code: String(values.get("code")), name: String(values.get("name")), description: String(values.get("description")), domain: String(values.get("domain")), version: "1.0", status: "draft" } }, { onSuccess: () => { formElement.reset(); invalidate(getListAdminCompetencyFrameworksQueryKey(), getListAdminAuditEventsQueryKey()); saved("Framework kompetensi disimpan."); } }); }}><Input name="code" required placeholder="Kode" /><Input name="name" required placeholder="Nama" /><Input name="domain" required placeholder="Domain" /><Input name="description" required placeholder="Deskripsi" /><Button type="submit">Tambah</Button></form><State loading={competencies.isLoading} error={competencies.error} empty={!competencies.data?.length}><div className="mt-4 space-y-2">{competencies.data?.map(framework => <div key={framework.id} className="rounded border p-3"><strong>{framework.code} · {framework.name}</strong><p className="text-sm">{framework.units.length} unit terpetakan</p></div>)}</div></State></CardContent></Card>}
    {tab === "competencies" && <CompetencyUnitEditor frameworks={competencies.data ?? []} invalidate={invalidate} />}
    {tab === "readiness" && <><Card><CardHeader><CardTitle>Versi aturan readiness baru</CardTitle><p className="text-sm text-muted-foreground">Aturan lama tetap tersimpan untuk audit. Critical safety selalu menjadi hard gate yang tidak dapat ditutupi skor lain.</p></CardHeader><CardContent><form onSubmit={createRule} className="grid gap-3 md:grid-cols-3"><select name="pathwayId" required className="h-10 rounded-md border bg-background px-3"><option value="">Pilih pathway</option>{pathways.data?.filter(pathway => pathway.status === "active").map(pathway => <option key={pathway.id} value={pathway.id}>{pathway.name}</option>)}</select><Input name="code" required placeholder="Kode aturan, contoh G1" /><Input name="name" required placeholder="Nama gate" /><Input name="sequence" required type="number" min="1" placeholder="Urutan" /><Input name="threshold" required type="number" min="0" max="100" defaultValue="80" aria-label="Threshold readiness" /><Input name="competencyUnitId" placeholder="ID unit kompetensi (opsional)" /><select name="assessmentMode" defaultValue="Mapped" className="h-10 rounded-md border bg-background px-3"><option>Mapped</option><option>All</option><option>None</option></select><select name="evidenceMode" defaultValue="Mapped" className="h-10 rounded-md border bg-background px-3"><option>Mapped</option><option>All</option><option>None</option></select><label className="flex items-center gap-2 text-sm"><input name="hardGate" type="checkbox" /> Hard gate unit/pathway</label><textarea name="requirement" required placeholder="Dasar dan persyaratan keputusan" className="min-h-24 rounded-md border bg-background p-3 text-sm md:col-span-3" /><Button type="submit" disabled={createReadinessRule.isPending} className="md:col-span-3">{createReadinessRule.isPending ? <Loader2 className="animate-spin" /> : "Publikasikan versi aturan"}</Button></form></CardContent></Card><State loading={readinessRules.isLoading} error={readinessRules.error} empty={!readinessRules.data?.length}><div className="grid gap-3">{readinessRules.data?.map(rule => <Card key={rule.id}><CardContent className="flex flex-wrap items-start justify-between gap-3 p-4"><div><strong>{rule.code} · {rule.name}</strong><p className="text-sm text-muted-foreground">{rule.pathwayId}{rule.competencyUnitId ? ` · Unit ${rule.competencyUnitId}` : " · Pathway-wide"} · threshold {rule.threshold}%</p><p className="mt-1 text-xs text-muted-foreground">{rule.requirement}</p></div><div className="flex gap-2"><Badge variant="outline">v{rule.ruleVersion}</Badge>{rule.hardGate && <Badge variant="destructive">HARD GATE</Badge>}</div></CardContent></Card>)}</div></State></>}
    {tab === "readinessAudit" && <ReadinessAuditHistory enabled={adminQueriesEnabled} users={users.data ?? []} pathways={pathways.data ?? []} errorMessage={adminErrorMessage} />}
    {tab === "diagnosticExceptions" && <DiagnosticProvenanceExceptions query={provenanceExceptions} />}
    {tab === "audit" && <State loading={audit.isLoading} error={audit.error} empty={!audit.data?.length}><div className="space-y-2">{audit.data?.map(event => {
      const isTimeZoneEvent = event.entityType === "trainer_reminder_preference" && (event.action === "delivery_blocked" || event.action === "delivery_configuration_recovered");
      const linkedRecovery = timeZoneRecoveries.get(event.id);
      const recovery = linkedRecovery?.entityId === event.entityId ? linkedRecovery : undefined;
      return <Card key={event.id} data-testid={`row-audit-${event.id}`}><CardContent className="p-4"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{auditDescription(event.action, event.entityType)}</p>{isTimeZoneEvent && event.action === "delivery_blocked" && <Badge variant={recovery ? "secondary" : "outline"} data-testid={`time-zone-incident-status-${event.id}`}>{recovery ? "Sudah pulih" : "Aktif"}</Badge>}</div>{isTimeZoneEvent ? <p className="mt-1 text-sm text-muted-foreground">Trainer: {users.data?.find(user => user.id === event.entityId)?.name ?? event.entityId} · {auditTime(event.createdAt)}{event.action === "delivery_blocked" ? recovery ? ` · Pulih ${auditTime(recovery.createdAt)}` : ". Minta trainer memperbarui preferensi pengingat." : " · Masalah zona waktu ditandai selesai."}</p> : <p className="mt-1 text-sm text-muted-foreground">Dilakukan oleh administrator · {auditTime(event.createdAt)}</p>}</CardContent></Card>;
    })}</div></State>}
    <div aria-live="polite" className="sr-only">{createUser.isPending ? "Menyimpan perubahan" : ""}</div>
    <AlertDialog open={!!confirm} onOpenChange={open => !open && setConfirm(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Konfirmasi perubahan status</AlertDialogTitle><AlertDialogDescription>Anda akan menonaktifkan atau mengarsipkan {confirm?.label}. Aksi ini tercatat dalam audit dan dapat memengaruhi akses aktif.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel data-testid="button-cancel-admin-confirm">Batal</AlertDialogCancel><AlertDialogAction onClick={archive} data-testid="button-confirm-admin-status">Lanjutkan</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Edit {editing?.kind}</DialogTitle><DialogDescription>Perubahan diperiksa server dan dicatat pada audit.</DialogDescription></DialogHeader>{editing && <form onSubmit={saveEdit} className="grid gap-4" aria-label={`Edit ${editing.kind}`}>
      {editing.kind === "user" && <><Input name="name" defaultValue={value("name")} aria-label="Nama pengguna" required data-testid="input-edit-user-name" /><Input name="email" type="email" defaultValue={value("email")} aria-label="Email pengguna" data-testid="input-edit-user-email" /><Input name="organization" defaultValue={value("organization")} aria-label="Organisasi pengguna" data-testid="input-edit-user-organization" /><label className="grid gap-1 text-sm">Provider autentikasi<Input name="authProvider" defaultValue={value("authProvider")} aria-label="Provider autentikasi" data-testid="input-edit-user-auth-provider" required /></label><label className="grid gap-1 text-sm">Subject autentikasi<Input name="authSubject" defaultValue={value("authSubject")} aria-label="Subject autentikasi" data-testid="input-edit-user-auth-subject" /><span className="text-xs text-muted-foreground">Subject dari provider untuk binding identitas, bukan credential.</span></label><div role="group" aria-label="Peran pengguna" className="flex flex-wrap gap-3">{roles.map(role => <label key={role} className="flex items-center gap-2 text-sm"><input name="roles" type="checkbox" value={role} defaultChecked={Array.isArray(editing.item.roles) && editing.item.roles.includes(role)} />{role}</label>)}</div></>}
      {editing.kind === "program" && <><Input name="name" defaultValue={value("name")} aria-label="Nama program" required /><Input name="domain" defaultValue={value("domain")} aria-label="Domain program" required /><Input name="description" defaultValue={value("description")} aria-label="Deskripsi program" required /></>}
      {editing.kind === "pathway" && <><Input name="name" defaultValue={value("name")} aria-label="Nama pathway" required /><Input name="type" defaultValue={value("type")} aria-label="Tipe pathway" required /><Input name="outcome" defaultValue={value("outcome")} aria-label="Outcome pathway" required /></>}
      {editing.kind === "cohort" && <><Input name="name" defaultValue={value("name")} aria-label="Nama cohort" required /><Input name="startsOn" type="date" defaultValue={value("startsOn")} aria-label="Tanggal mulai cohort" /><Input name="endsOn" type="date" defaultValue={value("endsOn")} aria-label="Tanggal selesai cohort" /></>}
      {editing.kind === "enrollment" && <><label className="grid gap-1 text-sm">Pathway<select name="pathwayId" defaultValue={value("pathwayId")} className="h-10 rounded-md border bg-background px-3">{pathways.data?.map(pathway => <option key={pathway.id} value={pathway.id}>{pathway.name}</option>)}</select></label><label className="grid gap-1 text-sm">Trainer<select name="trainerId" defaultValue={value("trainerId")} className="h-10 rounded-md border bg-background px-3"><option value="">Tidak ditugaskan</option>{users.data?.filter(user => user.roles.includes("trainer")).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label className="grid gap-1 text-sm">Assessor<select name="assessorId" defaultValue={value("assessorId")} className="h-10 rounded-md border bg-background px-3"><option value="">Tidak ditugaskan</option>{users.data?.filter(user => user.roles.includes("assessor")).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label className="grid gap-1 text-sm">Cohort<select name="cohortId" defaultValue={value("cohortId")} className="h-10 rounded-md border bg-background px-3"><option value="">Tanpa cohort</option>{cohorts.data?.map(cohort => <option key={cohort.id} value={cohort.id}>{cohort.name}</option>)}</select></label></>}
      {editing.kind === "knowledge" && <><select name="category" defaultValue={value("category")} className="h-10 rounded-md border bg-background px-3"><option value="help">Help Desk</option><option value="energy">TERAS & Energi</option></select><Input name="title" defaultValue={value("title")} required aria-label="Judul artikel" /><textarea name="body" defaultValue={value("body")} required className="min-h-32 rounded-md border bg-background p-3 text-sm" aria-label="Isi artikel" /><AudienceSelector selected={Array.isArray(editing.item.audience) ? editing.item.audience as string[] : []} /></>}
      {editing.kind === "knowledge" ? <p className="text-sm text-muted-foreground">Status saat ini: {value("status")}. Mengedit artikel terbit membuat versi draft baru; versi lama tetap terlihat sampai draft diterbitkan.</p> : <label className="grid gap-1 text-sm">Status<select name="status" defaultValue={value("status")} className="h-10 rounded-md border bg-background px-3" data-testid="select-edit-status">{(editing.kind === "user" || editing.kind === "enrollment" ? ["active", "inactive", ...(editing.kind === "enrollment" ? ["completed"] : [])] : ["active", "archived"]).map(status => <option key={status} value={status}>{status}</option>)}</select></label>}
      <DialogFooter><Button type="submit" disabled={updateUser.isPending || updateProgram.isPending || updatePathway.isPending || updateCohort.isPending || updateEnrollment.isPending || updateKnowledge.isPending || rolesMutation.isPending} data-testid="button-save-admin-edit">Simpan perubahan</Button></DialogFooter>
    </form>}</DialogContent></Dialog>
  </div>;
}

type AdminTab = "summary" | "users" | "programs" | "pathways" | "cohorts" | "enrollments" | "knowledge" | "competencies" | "readiness" | "readinessAudit" | "diagnosticExceptions" | "audit";
type SummaryQuery = { data?: AdminOperationalSummary; isLoading: boolean; error: unknown };

export function hasPermanentReminderEscalations(summary?: Pick<AdminOperationalSummary, "failedTrainerReminders">) {
  return Boolean(summary?.failedTrainerReminders.some(item => item.status === "open"));
}

function NotificationChannelStatus({ label, notification }: {
  label: string;
  notification: AdminOperationalSummary["failedTrainerReminders"][number]["emailNotification"];
}) {
  const statusLabel = notification?.status === "sent" ? "Terkirim"
    : notification?.status === "failed" ? "Gagal"
      : notification?.status === "sending" ? "Sedang dikirim"
        : notification?.status === "pending" ? "Menunggu"
          : "Belum dicoba";
  const isSent = notification?.status === "sent";
  const isFailed = notification?.status === "failed";
  return <div className={`rounded-md border p-3 ${isSent ? "border-emerald-500/40 bg-emerald-500/5" : isFailed ? "border-destructive/40 bg-destructive/5" : "bg-muted/30"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold">{label}</p>
      <Badge variant="outline" className={isSent ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-300" : isFailed ? "border-destructive/40 text-destructive" : ""}>{statusLabel}</Badge>
    </div>
    {notification?.attemptedAt && <p className="mt-1 text-xs text-muted-foreground">Percobaan {auditTime(notification.attemptedAt)}</p>}
    {notification?.sentAt && <p className="mt-1 text-xs text-muted-foreground">Terkirim {auditTime(notification.sentAt)}</p>}
    {notification?.reason && <p className="mt-2 text-sm text-destructive">{notification.reason}</p>}
  </div>;
}

type ReminderEscalationStatusFilter = "open" | "resolved";
const reminderEscalationPageSize = 25;

type ReminderEscalationPage = {
  items: AdminReminderEscalation[];
  pagination: { offset: number; returned: number; total: number; hasMore: boolean };
  counts: { open: number; resolved: number; total: number };
};

export function getReminderEscalationHistoryRefetchInterval(
  data: { pages: ReminderEscalationPage[] } | undefined,
  displayedOffset: number,
) {
  return pendingReminderEscalationPageOffsets(data, displayedOffset).length ? reminderDeliveryPollingInterval : false;
}

export function pendingReminderEscalationPageOffsets(
  data: { pages: ReminderEscalationPage[] } | undefined,
  displayedOffset: number,
) {
  return data?.pages.filter(page =>
    page.pagination.offset <= displayedOffset && page.items.some(hasReminderDeliveryInProgress)
  ).map(page => page.pagination.offset) ?? [];
}

function updateReminderEscalationChannels(
  data: InfiniteData<ReminderEscalationPage, number> | undefined,
  offset: number,
  refreshed: ReminderEscalationPage,
) {
  if (!data) return data;
  const notifications = new Map(refreshed.items.map(item => [item.id, item]));
  let changed = false;
  const pages = data.pages.map(page => {
    if (page.pagination.offset !== offset) return page;
    let pageChanged = false;
    const items = page.items.map(item => {
      const latest = notifications.get(item.id);
      if (!latest || item.status !== latest.status || !hasReminderDeliveryInProgress(item)) return item;
      if (JSON.stringify([item.emailNotification, item.webhookNotification]) === JSON.stringify([latest.emailNotification, latest.webhookNotification])) return item;
      changed = true;
      pageChanged = true;
      return { ...item, emailNotification: latest.emailNotification, webhookNotification: latest.webhookNotification };
    });
    return pageChanged ? { ...page, items } : page;
  });
  return changed ? { ...data, pages } : data;
}

export type ReminderEscalationUrlState = {
  status: ReminderEscalationStatusFilter;
  offset: number;
};

export function reminderEscalationStateFromSearch(search: string): ReminderEscalationUrlState {
  const params = new URLSearchParams(search);
  const status = params.get("escalationStatus");
  const offset = Number(params.get("escalationOffset"));
  return {
    status: status === "resolved" ? "resolved" : "open",
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
  };
}

export function updateReminderEscalationUrl(state: ReminderEscalationUrlState) {
  const url = new URL(window.location.href);
  url.searchParams.set("escalationStatus", state.status);
  if (state.offset > 0) url.searchParams.set("escalationOffset", String(state.offset));
  else url.searchParams.delete("escalationOffset");
  window.history.pushState({}, "", url);
}

export function reminderEscalationQueryParams(status: ReminderEscalationStatusFilter, offset = 0) {
  return { status, limit: reminderEscalationPageSize, offset };
}

export function nextReminderEscalationPageOffset(page: ReminderEscalationPage) {
  return page.pagination.hasMore ? page.pagination.offset + page.pagination.returned : undefined;
}

export function mergeReminderEscalationPages(pages: ReminderEscalationPage[] = []) {
  const seen = new Set<string>();
  return pages.flatMap(page => page.items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }));
}

export function ReminderEscalationHistory({ enabled, onResolve, loadPage = listAdminReminderEscalations, pollInterval = reminderDeliveryPollingInterval }: {
  enabled: boolean;
  onResolve: (item: AdminReminderEscalation) => void;
  loadPage?: typeof listAdminReminderEscalations;
  pollInterval?: number;
}) {
  const client = useQueryClient();
  const [urlState, setUrlState] = useState<ReminderEscalationUrlState>(() => reminderEscalationStateFromSearch(window.location.search));
  const { status, offset } = urlState;
  useEffect(() => {
    const restoreFromUrl = () => setUrlState(reminderEscalationStateFromSearch(window.location.search));
    window.addEventListener("popstate", restoreFromUrl);
    return () => window.removeEventListener("popstate", restoreFromUrl);
  }, []);
  const historyKey = getListAdminReminderEscalationsQueryKey(reminderEscalationQueryParams(status));
  const history = useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam }) => loadPage(reminderEscalationQueryParams(status, pageParam)),
    initialPageParam: 0,
    getNextPageParam: nextReminderEscalationPageOffset,
    enabled,
    staleTime: queryOptions.staleTime,
    refetchOnMount: queryOptions.refetchOnMount,
  });
  // Poll only pages with in-flight channels. Full infinite-query refetches still serve
  // explicit invalidation and remounts, but must not be used for each status tick.
  useEffect(() => {
    const pendingOffsets = enabled ? pendingReminderEscalationPageOffsets(history.data, offset) : [];
    if (!pendingOffsets.length) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await Promise.all(pendingOffsets.map(async pageOffset => {
        try {
          const refreshed = await loadPage(reminderEscalationQueryParams(status, pageOffset));
          if (active) client.setQueryData<InfiniteData<ReminderEscalationPage, number>>(
            historyKey,
            current => updateReminderEscalationChannels(current, pageOffset, refreshed),
          );
        } catch {
          // Preserve the last known status and retry the pending page next tick.
        }
      }));
      if (active) timer = setTimeout(poll, pollInterval);
    };
    timer = setTimeout(poll, pollInterval);
    return () => { active = false; clearTimeout(timer); };
  }, [client, enabled, history.data, loadPage, offset, pollInterval, status]);
  const loadedPages = history.data?.pages ?? [];
  const displayedPages = loadedPages.filter(page => page.pagination.offset <= offset);
  const displayedLastPage = displayedPages.at(-1);
  useEffect(() => {
    const loadedLastPage = loadedPages.at(-1);
    if (!enabled || history.isFetchingNextPage || history.isFetchNextPageError || !loadedLastPage || loadedLastPage.pagination.offset >= offset || !loadedLastPage.pagination.hasMore) return;
    void history.fetchNextPage();
  }, [enabled, history, loadedPages, offset]);
  const items = mergeReminderEscalationPages(displayedPages);
  const counts = history.data?.pages[0]?.counts;
  const filteredTotal = history.data?.pages[0]?.pagination.total ?? 0;
  const selectStatus = (nextStatus: ReminderEscalationStatusFilter) => {
    if (nextStatus === status && offset === 0) return;
    const nextState = { status: nextStatus, offset: 0 };
    updateReminderEscalationUrl(nextState);
    setUrlState(nextState);
  };
  const loadNextPage = async () => {
    const displayedPageIndex = loadedPages.findIndex(page => page.pagination.offset === displayedLastPage?.pagination.offset);
    const cachedNextPage = displayedPageIndex >= 0 ? loadedPages[displayedPageIndex + 1] : undefined;
    const result = cachedNextPage ? undefined : await history.fetchNextPage();
    const nextPage = cachedNextPage ?? result?.data?.pages.at(-1);
    if (!nextPage || nextPage.pagination.offset <= offset) return;
    const nextState = { status, offset: nextPage.pagination.offset };
    updateReminderEscalationUrl(nextState);
    setUrlState(nextState);
  };

  return <section aria-labelledby="reminder-escalation-history-title" data-testid="admin-reminder-escalation-history">
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle id="reminder-escalation-history-title">Riwayat eskalasi pengingat</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Telusuri seluruh audit kegagalan permanen dan catatan penyelesaiannya.</p>
          </div>
          <Badge variant="secondary" data-testid="reminder-escalation-total">{counts?.total ?? "—"} total</Badge>
        </div>
        <div className="flex flex-wrap gap-2 pt-2" aria-label="Filter status eskalasi">
          <Button
            type="button"
            size="sm"
            variant={status === "open" ? "default" : "outline"}
            aria-pressed={status === "open"}
            onClick={() => selectStatus("open")}
            data-testid="filter-reminder-escalations-open"
          >
            Terbuka ({counts?.open ?? "—"})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={status === "resolved" ? "default" : "outline"}
            aria-pressed={status === "resolved"}
            onClick={() => selectStatus("resolved")}
            data-testid="filter-reminder-escalations-resolved"
          >
            Selesai ({counts?.resolved ?? "—"})
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <State loading={history.isLoading} error={history.data ? null : history.error} empty={!history.isLoading && items.length === 0}>
          <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">Menampilkan {items.length} dari {filteredTotal} eskalasi {status === "open" ? "terbuka" : "selesai"}.</p>
          <div className="divide-y">{items.map(item => <article key={item.id} className="grid gap-3 py-4 first:pt-0 md:grid-cols-[1fr_auto] md:items-start" data-testid={`reminder-escalation-${item.id}`}>
            <div>
              <p className="font-semibold">{item.target}</p>
              <p className="mt-1 text-sm">Trainer: <strong>{item.trainerName}</strong></p>
              <p className="mt-1 text-sm text-muted-foreground">Target {auditTime(item.targetAt)} · Percobaan terakhir {auditTime(item.lastAttemptAt)}</p>
              <p className="mt-2 text-sm text-destructive">{item.reason}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Status kanal pemberitahuan"><NotificationChannelStatus label="Email pengelola" notification={item.emailNotification} /><NotificationChannelStatus label="Webhook cadangan" notification={item.webhookNotification} /></div>
              {item.resolution && <div className="mt-3 rounded-md bg-muted/50 p-3 text-sm" data-testid={`reminder-resolution-${item.id}`}><p className="whitespace-pre-wrap break-words">{item.resolution.note}</p><p className="mt-1 text-xs text-muted-foreground">Ditangani {auditTime(item.resolution.resolvedAt)} · Aktor {item.resolution.resolvedByPersonId}</p></div>}
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge variant={item.status === "open" ? "outline" : "secondary"} className={item.status === "open" ? "border-destructive/40 text-destructive" : ""}>{item.status === "open" ? "Perlu tindakan" : "Selesai"}</Badge>
              {item.status === "open" && <Button size="sm" onClick={() => onResolve(item)} data-testid={`button-resolve-history-reminder-${item.id}`}>Tandai ditangani</Button>}
            </div>
          </article>)}</div>
          {history.isFetchNextPageError && <p className="mt-4 text-sm text-destructive" role="alert" data-testid="reminder-escalation-page-error">Gagal memuat halaman berikutnya. {adminErrorMessage(history.error)}</p>}
          {displayedLastPage?.pagination.hasMore && <div className="mt-4 flex justify-center"><Button type="button" variant="outline" onClick={loadNextPage} disabled={history.isFetchingNextPage} data-testid="button-load-more-reminder-escalations">{history.isFetchingNextPage ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Memuat…</> : history.isFetchNextPageError ? "Coba lagi" : "Muat halaman berikutnya"}</Button></div>}
        </State>
      </CardContent>
    </Card>
  </section>;
}

function OperationalSummary({ summary, observability, selectedQueue, filters, onFilterChange, onOpenQueue, onOpenTab, onOlderAgentHealth, onNewerAgentHealth, agentHealthPage }: { summary: SummaryQuery; observability: ReturnType<typeof useGetAdminAgentObservability<AdminAgentObservability>>; selectedQueue: QueueId | null; filters: QueueFilters; onFilterChange: (key: QueueFilterKey, value: string) => void; onOpenQueue: (queue: QueueId) => void; onOpenTab: (tab: AdminTab) => void; onOlderAgentHealth: () => void; onNewerAgentHealth: () => void; agentHealthPage: number }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [resolvingReminderId, setResolvingReminderId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const resolveReminder = useResolveAdminReminderEscalation();
  const activeQueue = summary.data?.queues.find(queue => queue.id === selectedQueue);
  const openReminders = summary.data?.failedTrainerReminders.filter(item => item.status === "open") ?? [];
  const filterOptions = activeQueue ? {
    learner: uniqueQueueOptions(activeQueue.items, "learnerId", "learnerName"),
    pathway: uniqueQueueOptions(activeQueue.items, "pathwayId", "pathwayName"),
    trainer: uniqueQueueOptions(activeQueue.items, "trainerId", "trainerName", "Belum ditugaskan"),
    assessor: uniqueQueueOptions(activeQueue.items, "assessorId", "assessorName", "Belum ditugaskan"),
  } : null;
  const filteredItems = activeQueue ? filterQueueItems(activeQueue.items, filters) : [];
  const hasFilters = queueFilterKeys.some(key => filters[key]);
  const submitResolution = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resolvingReminderId || !resolutionNote.trim()) return;
    resolveReminder.mutate({ reminderDeliveryId: resolvingReminderId, data: { note: resolutionNote.trim() } }, {
      onSuccess: async () => {
        setResolvingReminderId(null);
        setResolutionNote("");
        await Promise.all([
          client.invalidateQueries({ queryKey: getGetAdminOperationalSummaryQueryKey() }),
           client.invalidateQueries({ queryKey: getListAdminReminderEscalationsQueryKey() }),
          client.invalidateQueries({ queryKey: getListAdminAuditEventsQueryKey() }),
        ]);
        toast({ title: "Eskalasi ditandai selesai", description: "Catatan, aktor, dan waktu penyelesaian telah disimpan." });
      },
      onError: error => toast({ variant: "destructive", title: "Gagal menyelesaikan eskalasi", description: adminErrorMessage(error) }),
    });
  };
  return <><State loading={summary.isLoading} error={summary.error} empty={!summary.data}>
    {summary.data && <div className="space-y-6" data-testid="admin-operational-summary">
      <section aria-labelledby="platform-pulse-title">
        <div className="mb-3 flex items-center justify-between gap-3"><div><h2 id="platform-pulse-title" className="text-lg font-semibold">Kondisi platform</h2><p className="text-sm text-muted-foreground">Snapshot operasional dari data aktif.</p></div><span className="text-xs text-muted-foreground">Diperbarui {auditTime(summary.data.generatedAt)}</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{summary.data.metrics.map(metric => <Card key={metric.id}><CardContent className="p-5"><p className="text-sm font-medium text-muted-foreground">{metric.label}</p><p className="mt-2 text-3xl font-bold tabular-nums">{metric.value}</p><p className="mt-2 text-xs text-muted-foreground">{metric.description}</p></CardContent></Card>)}</div>
      </section>
      <section aria-labelledby="agent-observability-title" data-testid="admin-agent-observability">
        <Card><CardHeader><CardTitle id="agent-observability-title">Kesehatan analisis AI</CardTitle><p className="text-sm text-muted-foreground">Total lengkap untuk 30 tanggal kalender UTC terakhir (termasuk hari ini), terpisah dari halaman ledger. Tanpa identitas, prompt, atau isi bukti.</p></CardHeader><CardContent>
          <State loading={observability.isLoading || observability.isFetching} error={observability.error} empty={!observability.data}>
            <p className="mb-3 text-sm text-muted-foreground">Periode {observability.data?.period.fromDay}–{observability.data?.period.toDay} UTC · seluruh run, bukan sampel halaman</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Total run 30 hari" value={observability.data?.period.totals.runCount ?? 0} /><Metric label="Selesai / parsial / gagal" value={`${observability.data?.period.totals.completedCount ?? 0} / ${observability.data?.period.totals.partialCount ?? 0} / ${observability.data?.period.totals.failedCount ?? 0}`} /><Metric label="Fallback" value={observability.data?.period.totals.fallbackCount ?? 0} /><Metric label="Rasio fallback" value={`${Math.round(100 * (observability.data?.period.totals.fallbackCount ?? 0) / (observability.data?.period.totals.runCount || 1))}%`} /></div>
            <h3 className="mt-5 font-semibold">Tren 30 hari lengkap (UTC)</h3><div className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm">{observability.data?.period.trends.map(day => <div key={day.day} className="flex justify-between gap-2 border-b py-1"><span>{day.day}</span><span className="tabular-nums">{day.runCount} run · {day.fallbackCount} fallback · {day.partialCount} parsial</span></div>)}</div>
          </State>
          <h3 className="mt-6 border-t pt-5 font-semibold">Detail ledger · halaman {agentHealthPage}</h3><p className="mb-3 text-sm text-muted-foreground">Jendela bergulir 30 hari; maksimal 1.000 run per halaman. Angka di bawah hanya untuk halaman ini, bukan total 30 tanggal UTC.</p>
          <State loading={observability.isLoading || observability.isFetching} error={observability.error} empty={!observability.data?.totals.runCount}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Run" value={observability.data?.totals.runCount ?? 0} /><Metric label="Selesai / parsial / gagal" value={`${observability.data?.totals.completedCount ?? 0} / ${observability.data?.totals.partialCount ?? 0} / ${observability.data?.totals.failedCount ?? 0}`} /><Metric label="Fallback" value={`${Math.round((observability.data?.totals.fallbackRate ?? 0) * 100)}%`} /><Metric label="Latensi p95" value={observability.data?.totals.p95TerminalLatencyMs == null ? "—" : `${Math.round(observability.data.totals.p95TerminalLatencyMs)} ms`} /></div>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div><h3 className="font-semibold">Tren harian (UTC, halaman ini)</h3><div className="mt-2 space-y-1 text-sm">{observability.data?.trends.map(day => <div key={day.day} className="flex justify-between gap-2 border-b py-1"><span>{day.day}</span><span className="tabular-nums">{day.runCount} run · {day.fallbackCount} fallback · {day.partialCount} parsial</span></div>)}</div></div>
            <div><h3 className="font-semibold">Keputusan kebijakan</h3><div className="mt-2 space-y-1 text-sm">{Object.entries(observability.data?.policyCounts ?? {}).map(([policy, total]) => <p key={policy}>{policy}: {total}</p>)}</div><h3 className="mt-4 font-semibold">Agent · provider · model</h3><div className="mt-2 space-y-1 text-sm">{observability.data?.dimensions.map((item, index) => <p key={index}>{item.agentVersion} · {item.provider ?? "tanpa provider"} · {item.model ?? "tanpa model"}: {item.runCount}</p>)}</div></div>
          </div>
        </State><div className="mt-4 flex gap-2"><Button variant="outline" disabled={agentHealthPage === 1 || observability.isFetching} onClick={onNewerAgentHealth}>Halaman lebih baru</Button><Button variant="outline" disabled={!observability.data?.nextCursor || observability.isFetching} onClick={onOlderAgentHealth}>Halaman lebih lama</Button></div></CardContent></Card>
      </section>
      {hasPermanentReminderEscalations(summary.data) && <section id="failed-trainer-reminders" aria-labelledby="failed-trainer-reminders-title" role="alert" data-testid="admin-failed-trainer-reminders">
        <Card className="border-destructive/60 bg-destructive/5">
          <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle id="failed-trainer-reminders-title" className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-5 w-5" />Pengingat trainer gagal permanen</CardTitle><p className="mt-1 text-sm text-muted-foreground">Pengiriman telah dihentikan setelah tiga percobaan. Tindak lanjuti target ini secara manual.</p></div><Badge variant="destructive" className="text-sm">{summary.data.reminderEscalationCounts.open}</Badge></div></CardHeader>
          <CardContent><div className="divide-y">{openReminders.map(item => <article key={item.id} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto] md:items-start" data-testid={`failed-trainer-reminder-${item.id}`}><div><p className="font-semibold">{item.target}</p><p className="mt-1 text-sm">Trainer: <strong>{item.trainerName}</strong></p><p className="mt-1 text-sm text-muted-foreground">Target {auditTime(item.targetAt)} · Percobaan terakhir {auditTime(item.lastAttemptAt)}</p><p className="mt-2 text-sm text-destructive">{item.reason}</p><div className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Status kanal pemberitahuan"><NotificationChannelStatus label="Email pengelola" notification={item.emailNotification} /><NotificationChannelStatus label="Webhook cadangan" notification={item.webhookNotification} /></div></div><div className="flex flex-col items-end gap-2"><Badge variant="outline" className="border-destructive/40 text-destructive">Perlu tindakan</Badge><Button size="sm" onClick={() => { setResolvingReminderId(item.id); setResolutionNote(""); }} data-testid={`button-resolve-reminder-${item.id}`}>Tandai ditangani</Button></div></article>)}</div></CardContent>
        </Card>
      </section>}
      <ReminderEscalationHistory enabled={Boolean(summary.data)} onResolve={item => { setResolvingReminderId(item.id); setResolutionNote(""); }} />
      <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <Card className={summary.data.bottleneck.count > 0 ? "border-amber-500/40 bg-amber-500/5" : ""}>
          <CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-600" />Bottleneck lifecycle</CardTitle></CardHeader>
          <CardContent><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-2xl font-bold">{summary.data.bottleneck.label}</p><p className="mt-1 max-w-xl text-sm text-muted-foreground">{summary.data.bottleneck.description}</p></div><div className="text-right"><p className="text-4xl font-bold tabular-nums">{summary.data.bottleneck.count}</p>{summary.data.bottleneck.stage !== "clear" && <Button className="mt-3" size="sm" onClick={() => onOpenQueue(summary.data!.bottleneck.stage as QueueId)}>Lihat item<ArrowRight className="ml-2 h-4 w-4" /></Button>}</div></div></CardContent>
        </Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5" />Assignment belum lengkap</CardTitle></CardHeader><CardContent className="space-y-4"><div className="grid grid-cols-2 gap-3"><div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">Tanpa trainer</p><p className="mt-1 text-2xl font-bold">{summary.data.incompleteAssignments.trainer}</p></div><div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">Tanpa assessor</p><p className="mt-1 text-2xl font-bold">{summary.data.incompleteAssignments.assessor}</p></div></div><Button variant="outline" className="w-full" onClick={() => onOpenTab("enrollments")}>Kelola assignment</Button></CardContent></Card>
      </div>
      <section aria-labelledby="queues-title"><h2 id="queues-title" className="mb-3 text-lg font-semibold">Antrean operasional</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{summary.data.queues.map(queue => <Card key={queue.id} className={selectedQueue === queue.id ? "border-primary" : ""}><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><ClipboardCheck className="h-5 w-5 text-primary" /><Badge variant={queue.count ? "default" : "secondary"}>{queue.count}</Badge></div><h3 className="mt-4 font-semibold">{queue.label}</h3><p className="mt-1 min-h-10 text-xs text-muted-foreground">{queue.description}</p><Button variant="ghost" size="sm" className="mt-3 -ml-3" aria-expanded={selectedQueue === queue.id} onClick={() => onOpenQueue(queue.id)} data-testid={`button-open-admin-queue-${queue.id}`}>Lihat item<ArrowRight className="ml-2 h-4 w-4" /></Button></CardContent></Card>)}</div></section>
      {activeQueue && <Card data-testid={`admin-queue-detail-${activeQueue.id}`}><CardHeader><CardTitle>{activeQueue.label}</CardTitle><p className="text-sm text-muted-foreground">{activeQueue.description}</p></CardHeader><CardContent className="space-y-5">{activeQueue.items.length > 0 && filterOptions && <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Filter antrean"><QueueFilter label="Learner" value={filters.learner} options={filterOptions.learner} onChange={value => onFilterChange("learner", value)} /><QueueFilter label="Pathway" value={filters.pathway} options={filterOptions.pathway} onChange={value => onFilterChange("pathway", value)} /><QueueFilter label="Trainer" value={filters.trainer} options={filterOptions.trainer} onChange={value => onFilterChange("trainer", value)} /><QueueFilter label="Assessor" value={filters.assessor} options={filterOptions.assessor} onChange={value => onFilterChange("assessor", value)} /></div>}{filteredItems.length ? <><p className="text-sm text-muted-foreground" aria-live="polite">Menampilkan {filteredItems.length} dari {activeQueue.items.length} item.</p><div className="divide-y">{filteredItems.map(item => <article key={item.id} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto] md:items-center"><div><div className="flex flex-wrap items-center gap-2"><strong>{item.title}</strong><Badge variant="outline">{item.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{item.learnerName} · {item.pathwayName}</p><p className="mt-1 text-xs text-muted-foreground">Trainer: {item.trainerName ?? "Belum ditugaskan"} · Assessor: {item.assessorName ?? "Belum ditugaskan"}</p></div><Button size="sm" variant="outline" onClick={() => onOpenTab("enrollments")}>Kelola enrollment</Button></article>)}</div></> : <div className="rounded-md border border-dashed p-8 text-center" role="status"><p className="font-medium">{hasFilters ? "Tidak ada item yang cocok" : "Antrean ini kosong"}</p><p className="mt-1 text-sm text-muted-foreground">{hasFilters ? "Ubah atau hapus filter untuk melihat item antrean lainnya." : "Tidak ada item yang membutuhkan tindak lanjut saat ini."}</p>{hasFilters && <Button variant="outline" size="sm" className="mt-4" onClick={() => queueFilterKeys.forEach(key => onFilterChange(key, ""))}>Hapus semua filter</Button>}</div>}</CardContent></Card>}
      <Card><CardHeader><CardTitle>Tindakan berikutnya</CardTitle></CardHeader><CardContent>{summary.data.actions.length ? <div className="divide-y">{summary.data.actions.map(action => <div key={action.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><Badge variant={action.urgency === "critical" ? "destructive" : action.urgency === "attention" ? "default" : "secondary"} className="h-fit">{action.count}</Badge><div><p className="font-medium">{action.label}</p><p className="text-sm text-muted-foreground">{action.description}</p></div></div><Button size="sm" variant="outline" onClick={() => action.id === "review-failed-trainer-reminders" ? document.getElementById("failed-trainer-reminders")?.scrollIntoView({ behavior: "smooth", block: "start" }) : action.id.startsWith("resolve-") ? onOpenQueue(action.id.replace("resolve-", "") as QueueId) : onOpenTab(action.targetTab)}>Buka</Button></div>)}</div> : <p className="text-sm text-muted-foreground">Tidak ada tindakan mendesak. Semua assignment dan antrean lifecycle dalam kondisi bersih.</p>}</CardContent></Card>
    </div>}
  </State><Dialog open={resolvingReminderId !== null} onOpenChange={open => { if (!open && !resolveReminder.isPending) { setResolvingReminderId(null); setResolutionNote(""); } }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Tandai eskalasi sudah ditangani</DialogTitle><DialogDescription>Tambahkan catatan audit tentang tindakan manual yang sudah dilakukan. Delivery kegagalan asli tidak akan diubah.</DialogDescription></DialogHeader>
      <form onSubmit={submitResolution} className="grid gap-4">
        <label className="grid gap-2 text-sm font-medium">Catatan penanganan<Textarea value={resolutionNote} onChange={event => setResolutionNote(event.target.value)} required minLength={1} maxLength={2000} placeholder="Contoh: Trainer dihubungi melalui telepon dan target dikonfirmasi." data-testid="input-reminder-resolution-note" /></label>
        <DialogFooter><Button type="button" variant="outline" onClick={() => { setResolvingReminderId(null); setResolutionNote(""); }} disabled={resolveReminder.isPending}>Batal</Button><Button type="submit" disabled={resolveReminder.isPending || !resolutionNote.trim()} data-testid="button-submit-reminder-resolution">{resolveReminder.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Simpan penyelesaian"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog></>;
}

function uniqueQueueOptions<T, IdKey extends keyof T, LabelKey extends keyof T>(items: T[], idKey: IdKey, labelKey: LabelKey, nullLabel?: string) {
  const options = new Map<string, string>();
  for (const item of items) {
    const rawId = item[idKey];
    if (rawId === null && nullLabel) options.set("unassigned", nullLabel);
    else if (typeof rawId === "string") options.set(rawId, typeof item[labelKey] === "string" ? item[labelKey] as string : rawId);
  }
  return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "id"));
}

function QueueFilter({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm"><span className="font-medium">{label}</span><select value={value} onChange={event => onChange(event.target.value)} className="h-10 rounded-md border bg-background px-3" data-testid={`filter-queue-${label.toLowerCase()}`}><option value="">Semua {label.toLowerCase()}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums">{value}</p></div>;
}

function AudienceSelector({ selected = ["learner", "trainer", "assessor", "admin"] }: { selected?: string[] }) {
  return <fieldset className="flex flex-wrap gap-3"><legend className="text-sm font-medium">Audiens</legend>{roles.map(role => <label key={role} className="flex items-center gap-1 text-sm"><input name="audience" type="checkbox" value={role} defaultChecked={selected.includes(role)} />{role}</label>)}</fieldset>;
}

function EntitySection({ title, onSubmit, fields, loading, error, items, onEdit, onArchive }: { title: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void; fields: ReactNode[]; loading: boolean; error: unknown; items?: Array<{ id: string; name: string; detail: string; status: string; [key: string]: unknown }>; onEdit: (item: { id: string; name: string; detail: string; status: string; [key: string]: unknown }) => void; onArchive: (item: { id: string; name: string; detail: string; status: string; [key: string]: unknown }) => void }) {
  return <><Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><form onSubmit={onSubmit} className="flex flex-wrap gap-3">{fields}<Button type="submit" data-testid={`button-create-${title.toLowerCase().replaceAll(" ", "-")}`}><Plus className="mr-2 h-4 w-4" />Tambah</Button></form></CardContent></Card><State loading={loading} error={error} empty={!items?.length}><div className="grid gap-3">{items?.map(item => <Card key={item.id} data-testid={`row-admin-${item.id}`}><CardContent className="flex items-center justify-between gap-3 p-4"><div><strong>{item.name}</strong><p className="text-sm text-muted-foreground">{item.detail}</p></div><div className="flex items-center gap-2"><Badge variant={item.status === "active" ? "default" : "secondary"}>{item.status}</Badge><Button size="sm" variant="outline" onClick={() => onEdit(item)} data-testid={`button-edit-${item.id}`}>Edit</Button><Button size="sm" variant="outline" disabled={item.status !== "active"} onClick={() => onArchive(item)} data-testid={`button-archive-${item.id}`}><Archive className="mr-1 h-3.5 w-3.5" />Arsipkan</Button></div></CardContent></Card>)}</div></State></>;
}