import React, { useState } from "react";
import {
  getListBaselineVersionsQueryKey,
  getListBaselineAuditQueryKey,
  getListManagedBaselinesQueryKey,
  getPreviewBaselinePublicationQueryKey,
  useGetBaselineVersion,
  useCancelBaselineDraft,
  useListBaselineAudit,
  useListBaselineVersions,
  useListManagedBaselines,
  usePreviewBaselinePublication,
  usePublishBaselineVersion,
  type BaselineAuditEvent,
  type BaselineVersionSummary,
} from "@workspace/api-client-react";
import { clearDraftIdempotencyKey, getDraftIdempotencyKey } from "@/lib/draft-idempotency";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitCompareArrows, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export function isBaselinePreviewConfirmed(confirmedFingerprint: string | null, currentFingerprint: string | undefined) {
  return Boolean(currentFingerprint && confirmedFingerprint === currentFingerprint);
}

export type BaselineRefreshSection = "versions" | "audit" | "active";

const baselineRefreshLabels: Record<BaselineRefreshSection, string> = {
  versions: "riwayat versi",
  audit: "audit versi",
  active: "status baseline aktif",
};

export async function refreshBaselinePublicationHistory({
  baselineId,
  invalidateQueries,
  sections = ["versions", "audit", "active"],
}: {
  baselineId: string;
  invalidateQueries: (queryKey: readonly unknown[]) => Promise<unknown>;
  sections?: BaselineRefreshSection[];
}): Promise<BaselineRefreshSection[]> {
  const keys: Record<BaselineRefreshSection, readonly unknown[]> = {
    versions: getListBaselineVersionsQueryKey(baselineId),
    audit: getListBaselineAuditQueryKey(baselineId),
    active: getListManagedBaselinesQueryKey(),
  };
  const results = await Promise.allSettled(sections.map(section => Promise.resolve().then(() => invalidateQueries(keys[section]))));
  return sections.filter((_, index) => results[index].status === "rejected");
}

export function BaselinePublicationResult({
  version,
  failedSections,
  retrying,
  onRetry,
}: {
  version: number;
  failedSections: BaselineRefreshSection[];
  retrying: boolean;
  onRetry: () => void;
}) {
  return <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm" role="status" data-testid="baseline-publication-result">
    <p className="font-semibold text-emerald-400">Baseline v{version} berhasil dipublikasikan.</p>
    <p className="mt-1 text-muted-foreground">Enrollment baru akan memakai versi ini; histori learner lama tetap dipin.</p>
    {failedSections.length > 0 && <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-3" role="alert" data-testid="baseline-publication-refresh-warning">
      <p className="text-amber-300">Publikasi berhasil, tetapi {failedSections.map(section => baselineRefreshLabels[section]).join(", ")} belum dapat diperbarui. Tampilan bagian tersebut mungkin belum mencerminkan hasil terbaru.</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry} disabled={retrying}>
        {retrying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
        {retrying ? "Mencoba lagi…" : "Coba lagi pembaruan"}
      </Button>
    </div>}
  </div>;
}

export function BaselineVersionHistory({
  versions,
  audit,
  activeVersion,
}: {
  versions: BaselineVersionSummary[];
  audit: BaselineAuditEvent[];
  activeVersion: number | null;
}) {
  if (!versions.length) return <p className="text-xs text-muted-foreground">Belum ada versi baseline yang tercatat.</p>;

  return <div className="space-y-2">
    {versions.map(version => {
      const publishEvent = audit.find(event => event.versionId === version.id && event.action === "PUBLISH");
      const cancelEvent = audit.find(event => event.versionId === version.id && event.action === "CANCEL_DRAFT");
      const event = version.status === "CANCELLED" ? cancelEvent : publishEvent;
      const isActive = version.status === "PUBLISHED" && version.version === activeVersion;
      const reason = cancelEvent && typeof cancelEvent.details.reason === "string" ? cancelEvent.details.reason : null;
      const occurredAt = event?.createdAt
        ?? (version.status === "CANCELLED" ? version.cancelledAt : version.publishedAt)
        ?? version.createdAt;
      const actor = event?.actorId
        ?? (version.status === "CANCELLED" ? version.cancelledBy : version.publishedBy)
        ?? version.createdBy;

      return <article
        key={version.id}
        className={`rounded border p-3 text-xs ${
          isActive
            ? "border-emerald-500/40 bg-emerald-500/5"
            : version.status === "CANCELLED"
              ? "border-border/50 bg-black/20 opacity-80"
              : "border-border/50 bg-black/30"
        }`}
        data-testid={`baseline-version-${version.status.toLowerCase()}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Versi {version.version}</span>
            <Badge variant={isActive ? "default" : "outline"}>
              {isActive ? "AKTIF" : version.status === "DRAFT" ? "DRAFT — dapat ditindaklanjuti" : version.status}
            </Badge>
            {version.status === "CANCELLED" && <Badge variant="outline">Hanya baca</Badge>}
          </div>
          <time className="text-muted-foreground">{new Date(occurredAt).toLocaleString("id-ID")}</time>
        </div>
        <p className="mt-2 text-muted-foreground">Actor: <span className="break-all text-foreground">{actor}</span></p>
         {version.status === "CANCELLED" && (
          <>
            <p className="mt-1 text-muted-foreground">
              Alasan pembatalan: <span className="text-foreground">{reason ?? "Tidak tersedia pada audit lama."}</span>
            </p>
          </>
        )}
         <BaselineSnapshotDetails baselineId={version.baselineId} versionId={version.id} cancelled={version.status === "CANCELLED"} />
        {version.status === "PUBLISHED" && (
          publishEvent
          && typeof publishEvent.details.previewFingerprint === "string"
          && typeof publishEvent.details.changedPathwayCount === "number"
            ? <div className="mt-1 text-muted-foreground" data-testid={`baseline-publish-summary-${version.id}`}>
                <p>{publishEvent.details.changedPathwayCount} pathway berubah · {publishEvent.details.eligibleCohortCount ?? 0} cohort eligible · {publishEvent.details.preservedEnrollmentCount ?? 0} enrollment lama dipertahankan</p>
                <p>Fingerprint review: <span className="break-all text-foreground">{publishEvent.details.previewFingerprint}</span></p>
              </div>
            : <p className="mt-1 text-muted-foreground" data-testid={`baseline-publish-summary-${version.id}`}>
                Ringkasan review tidak tersedia pada audit lama.
              </p>
        )}
      </article>;
    })}
  </div>;
}

function BaselineSnapshotDetails({ baselineId, versionId, cancelled }: { baselineId: string; versionId: string; cancelled: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-3 rounded border border-border/50 bg-black/20 p-2" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium text-foreground">{cancelled ? "Tinjau isi snapshot yang ditutup" : "Tinjau isi snapshot versi ini"}</summary>
    {open && <BaselineSnapshotContent baselineId={baselineId} versionId={versionId} cancelled={cancelled} />}
  </details>;
}

function BaselineSnapshotContent({ baselineId, versionId, cancelled }: { baselineId: string; versionId: string; cancelled: boolean }) {
  const version = useGetBaselineVersion(baselineId, versionId);
  if (version.isLoading) return <p className="mt-3 text-muted-foreground">Memuat snapshot…</p>;
  if (version.error || !version.data) return <p className="mt-3 text-destructive" role="alert">Snapshot tidak dapat dimuat. Coba tutup dan buka kembali.</p>;
  const snapshot = version.data.snapshot as {
    baseline?: Record<string, unknown>;
    modules?: Array<Record<string, unknown>>;
    selections?: Array<Record<string, unknown>>;
  };
  return <div className="mt-3 grid gap-3" data-testid={cancelled ? "cancelled-baseline-snapshot" : "baseline-snapshot"}>
    <section>
      <h5 className="font-medium text-foreground">Metadata baseline</h5>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-muted-foreground">{JSON.stringify(snapshot.baseline ?? {}, null, 2)}</pre>
    </section>
    <section>
      <h5 className="font-medium text-foreground">Modul ({snapshot.modules?.length ?? 0})</h5>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-muted-foreground">{JSON.stringify(snapshot.modules ?? [], null, 2)}</pre>
    </section>
    <section>
      <h5 className="font-medium text-foreground">Pilihan pathway ({snapshot.selections?.length ?? 0})</h5>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-muted-foreground">{JSON.stringify(snapshot.selections ?? [], null, 2)}</pre>
    </section>
  </div>;
}

export function baselineCancellationFlow(baselineId: string, versionId: string) {
  return `baseline-cancellation:${baselineId}:${versionId}`;
}

export function baselineCancellationRequest(
  storage: Storage,
  baselineId: string,
  versionId: string,
  reason: string,
) {
  const normalizedReason = reason.trim();
  return {
    idempotencyKey: getDraftIdempotencyKey(
      storage,
      baselineCancellationFlow(baselineId, versionId),
      normalizedReason,
    ),
    reason: normalizedReason,
  };
}

export function BaselinePublicationGate() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [baselineId, setBaselineId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [cancellationReason, setCancellationReason] = useState("");
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);
  const [publicationResult, setPublicationResult] = useState<{ baselineId: string; version: number; failedSections: BaselineRefreshSection[] } | null>(null);
  const [retryingPublicationRefresh, setRetryingPublicationRefresh] = useState(false);
  const baselines = useListManagedBaselines({
    query: { queryKey: getListManagedBaselinesQueryKey() },
  });
  const versions = useListBaselineVersions(baselineId, {
    query: { enabled: Boolean(baselineId), queryKey: getListBaselineVersionsQueryKey(baselineId) },
  });
  const audit = useListBaselineAudit(baselineId, {
    query: { enabled: Boolean(baselineId), queryKey: getListBaselineAuditQueryKey(baselineId) },
  });
  const preview = usePreviewBaselinePublication(baselineId, versionId, {
    query: {
      enabled: Boolean(baselineId && versionId),
      queryKey: getPreviewBaselinePublicationQueryKey(baselineId, versionId),
    },
  });
  const publish = usePublishBaselineVersion();
  const cancel = useCancelBaselineDraft();
  const drafts = versions.data?.filter(version => version.status === "DRAFT") ?? [];
  const selectedBaseline = baselines.data?.find(baseline => baseline.baselineId === baselineId);

  const invalidatePublicationQueries = (queryKey: readonly unknown[]) => queryClient.invalidateQueries(
    { queryKey, exact: true },
    { throwOnError: true },
  );

  const retryPublicationRefresh = async () => {
    if (!publicationResult || retryingPublicationRefresh) return;
    const current = publicationResult;
    setRetryingPublicationRefresh(true);
    try {
      const failedSections = await refreshBaselinePublicationHistory({
        baselineId: current.baselineId,
        invalidateQueries: invalidatePublicationQueries,
        sections: current.failedSections,
      });
      setPublicationResult(previous => previous === current ? { ...current, failedSections } : previous);
    } finally {
      setRetryingPublicationRefresh(false);
    }
  };

  const selectBaseline = (next: string) => {
    setBaselineId(next);
    setVersionId("");
    setCancellationReason("");
    setConfirmedFingerprint(null);
  };

  const cancelSelectedDraft = () => {
    const reason = cancellationReason.trim();
    if (!versionId || !reason) return;
    const flow = baselineCancellationFlow(baselineId, versionId);
    const data = baselineCancellationRequest(window.localStorage, baselineId, versionId, reason);
    cancel.mutate({ baselineId, versionId, data }, {
      onSuccess: async result => {
        clearDraftIdempotencyKey(window.localStorage, flow);
        setConfirmedFingerprint(null);
        setVersionId("");
        setCancellationReason("");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListBaselineVersionsQueryKey(baselineId) }),
          queryClient.invalidateQueries({ queryKey: getListBaselineAuditQueryKey(baselineId) }),
          queryClient.invalidateQueries({ queryKey: getListManagedBaselinesQueryKey() }),
        ]);
        toast({
          title: `Draft baseline v${result.version} ditutup`,
          description: "Snapshot dan audit tetap tersimpan. Versi published serta pin learner tidak berubah.",
        });
      },
      onError: error => toast({
        variant: "destructive",
        title: "Draft tidak dapat ditutup",
        description: (error as { data?: { error?: string } }).data?.error ?? "Muat ulang daftar versi dan coba lagi.",
      }),
    });
  };

  const publishReviewedDraft = () => {
    if (!preview.data || !isBaselinePreviewConfirmed(confirmedFingerprint, preview.data.previewFingerprint)) return;
    publish.mutate({
      baselineId,
      versionId,
      data: { previewFingerprint: preview.data.previewFingerprint },
    }, {
      onSuccess: async result => {
        setConfirmedFingerprint(null);
        setVersionId("");
        setPublicationResult({ baselineId, version: result.version, failedSections: [] });
        toast({ title: `Baseline v${result.version} dipublikasikan`, description: "Enrollment baru akan memakai versi ini; histori learner lama tetap dipin." });
        const failedSections = await refreshBaselinePublicationHistory({
          baselineId,
          invalidateQueries: invalidatePublicationQueries,
        });
        setPublicationResult(previous => previous?.baselineId === baselineId && previous.version === result.version
          ? { ...previous, failedSections }
          : previous);
      },
      onError: error => toast({
        variant: "destructive",
        title: "Publikasi ditahan",
        description: (error as { data?: { error?: string } }).data?.error ?? "Muat ulang pratinjau dampak lalu konfirmasi kembali.",
      }),
    });
  };

  return <Card className="border-primary/30 bg-black/50" data-testid="baseline-publication-gate">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><GitCompareArrows className="h-5 w-5 text-primary" /> Gate publikasi baseline</CardTitle>
      <p className="text-sm text-muted-foreground">Bandingkan draft dengan snapshot aktif, lalu tinjau pathway, cohort, dan enrollment sebelum publikasi.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      {publicationResult?.baselineId === baselineId && <BaselinePublicationResult
        version={publicationResult.version}
        failedSections={publicationResult.failedSections}
        retrying={retryingPublicationRefresh}
        onRetry={retryPublicationRefresh}
      />}
      <label className="grid gap-2 text-sm">
        <span className="font-medium">Baseline dalam scope Anda</span>
        <select
          className="h-10 rounded-md border border-input bg-background px-3"
          value={baselineId}
          onChange={event => selectBaseline(event.target.value)}
          aria-label="Pilih baseline"
          disabled={baselines.isLoading}
        >
          <option value="">{baselines.isLoading ? "Memuat baseline…" : "Pilih baseline"}</option>
          {baselines.data?.map(baseline => <option key={baseline.baselineId} value={baseline.baselineId}>
            {baseline.name} ({baseline.code}) · Aktif {baseline.activeVersion === null ? "belum ada" : `v${baseline.activeVersion}`} · {baseline.draftCount} draft
          </option>)}
        </select>
        {baselines.error && <span className="text-destructive" role="alert">Daftar baseline dalam scope Anda tidak dapat dimuat.</span>}
        {!baselines.isLoading && !baselines.error && !baselines.data?.length && <span className="text-muted-foreground">Tidak ada baseline yang sesuai assignment aktif Anda.</span>}
      </label>
      {versions.isLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat versi baseline…</p>}
      {versions.error && <p className="text-sm text-destructive" role="alert">Baseline tidak dapat dimuat atau berada di luar scope Anda.</p>}
      {baselineId && <section className="space-y-2 rounded-md border border-border/60 bg-black/20 p-3" data-testid="baseline-publication-history">
        <strong className="text-sm">Riwayat versi baseline</strong>
        <p className="text-xs text-muted-foreground">Draft aktif dapat ditindaklanjuti di bawah. Versi published dan cancelled di riwayat ini hanya untuk ditinjau.</p>
        {audit.isLoading && <p className="text-xs text-muted-foreground">Memuat audit versi…</p>}
        {audit.error && <p className="text-xs text-destructive" role="alert">Audit versi tidak dapat dimuat.</p>}
        {versions.data && (
          <BaselineVersionHistory versions={versions.data} audit={audit.data ?? []} activeVersion={selectedBaseline?.activeVersion ?? null} />
        )}
      </section>}
      {baselineId && !versions.isLoading && !versions.error && <label className="grid gap-2 text-sm">
        <span className="font-medium">Draft yang akan ditinjau</span>
        <select className="h-10 rounded-md border border-input bg-background px-3" value={versionId} onChange={event => { setVersionId(event.target.value); setCancellationReason(""); setConfirmedFingerprint(null); }}>
          <option value="">Pilih draft</option>
          {drafts.map(version => <option key={version.id} value={version.id}>Versi {version.version}</option>)}
        </select>
        {!drafts.length && <span className="text-muted-foreground">Tidak ada draft yang dapat dipublikasikan.</span>}
      </label>}
      {versionId && <section className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div>
          <strong className="text-sm">Tutup draft ini</strong>
          <p className="mt-1 text-xs text-muted-foreground">Tindakan ini permanen untuk draft terpilih. Snapshot dan audit dipertahankan; versi published dan pin learner tidak berubah.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={cancellationReason}
            onChange={event => setCancellationReason(event.target.value)}
            placeholder="Alasan penutupan draft"
            aria-label="Alasan penutupan draft"
            maxLength={500}
          />
          <Button type="button" variant="destructive" onClick={cancelSelectedDraft} disabled={!cancellationReason.trim() || cancel.isPending}>
            {cancel.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
            Tutup draft
          </Button>
        </div>
      </section>}
      {preview.isLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Menghitung dampak dari snapshot immutable…</p>}
      {preview.error && <p className="text-sm text-destructive" role="alert">Pratinjau tidak dapat dibuat. Draft mungkin telah berubah atau tidak lagi tersedia.</p>}
      {preview.data && <div className="space-y-4" data-testid="baseline-publication-preview">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Aktif v{preview.data.activeVersion.version}</Badge>
          <span aria-hidden="true">→</span>
          <Badge>Draft v{preview.data.draftVersion.version}</Badge>
          <Badge variant={preview.data.changes.length ? "secondary" : "outline"}>{preview.data.changes.length} pathway berubah</Badge>
          <Badge variant={preview.data.baselineChanged ? "secondary" : "outline"}>{preview.data.baselineChanged ? "Metadata baseline berubah" : "Metadata baseline tetap"}</Badge>
        </div>
        {preview.data.baselineChanged && <section className="rounded-md border border-border/60 bg-black/30 p-3">
          <strong>Perubahan metadata baseline</strong>
          <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2">Sebelum{"\n"}{JSON.stringify(preview.data.baselineBefore, null, 2)}</pre>
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2">Sesudah{"\n"}{JSON.stringify(preview.data.baselineAfter, null, 2)}</pre>
          </div>
        </section>}
        <div className="grid gap-3 lg:grid-cols-2">
          {preview.data.changes.map(change => <section key={change.pathwayId} className="rounded-md border border-border/60 bg-black/30 p-3">
            <div className="flex items-center justify-between gap-2"><strong>{change.pathwayName}</strong><Badge variant="outline">{change.status}</Badge></div>
            <p className="mt-2 text-xs text-muted-foreground">Sebelum: {change.before.map(module => module.code).join(", ") || "tidak ada"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Sesudah: {change.after.map(module => module.code).join(", ") || "tidak ada"}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {change.addedModules.map(module => <span key={module.id} className="text-emerald-400">+ {module.code} {module.name}</span>)}
              {change.removedModules.map(module => <span key={module.id} className="text-amber-400">− {module.code} {module.name}</span>)}
              {change.modifiedModules.map(module => <span key={module.after.id} className="text-sky-400">~ {module.before.code} {module.before.name} → {module.after.code} {module.after.name} ({module.changedFields.join(", ")})</span>)}
              {change.orderChanged && <span className="text-sky-400">Urutan modul berubah</span>}
            </div>
          </section>)}
        </div>
        {!preview.data.changes.length && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Tidak ada perubahan module/pathway terhadap snapshot aktif.</p>}
        <section className="rounded-md border border-primary/30 bg-primary/5 p-4">
          <h4 className="font-semibold">Cohort dan enrollment terdampak</h4>
          <p className="mt-2 text-sm">{preview.data.impact.affectedPathways.filter(pathway => pathway.publicationOutcome === "NEW_ENROLLMENTS_USE_DRAFT").length} pathway akan memakai v{preview.data.draftVersion.version} untuk enrollment baru.</p>
          {preview.data.impact.affectedPathways.some(pathway => pathway.publicationOutcome === "REMOVED_FROM_DRAFT") && <p className="mt-1 text-sm text-amber-400">Pathway dihapus dari draft: {preview.data.impact.affectedPathways.filter(pathway => pathway.publicationOutcome === "REMOVED_FROM_DRAFT").map(pathway => pathway.pathwayName).join(", ")}. Enrollment lamanya tetap dipertahankan.</p>}
          <p className="mt-1 text-sm text-muted-foreground">Cohort aktif yang eligible: {preview.data.impact.eligibleCohorts.map(cohort => cohort.name).join(", ") || "tidak ada"}</p>
          <div className="mt-3 flex items-start gap-2 rounded bg-black/30 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <p><strong>{preview.data.impact.preservedEnrollmentCount} enrollment lama tidak berubah.</strong> {preview.data.impact.historyRule}</p>
          </div>
        </section>
        <label className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <Checkbox
            checked={isBaselinePreviewConfirmed(confirmedFingerprint, preview.data.previewFingerprint)}
            onCheckedChange={value => setConfirmedFingerprint(value === true ? preview.data.previewFingerprint : null)}
            aria-label="Konfirmasi pratinjau publikasi"
          />
          <span><strong>Saya telah meninjau perubahan dan dampak cohort.</strong><br /><span className="text-muted-foreground">Jika draft berubah, server menolak fingerprint pratinjau ini dan meminta peninjauan ulang.</span></span>
        </label>
        <Button type="button" onClick={publishReviewedDraft} disabled={!isBaselinePreviewConfirmed(confirmedFingerprint, preview.data.previewFingerprint) || publish.isPending} className="w-full">
          {publish.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <AlertTriangle className="mr-2 h-4 w-4" />}
          Publikasikan baseline setelah review
        </Button>
      </div>}
    </CardContent>
  </Card>;
}