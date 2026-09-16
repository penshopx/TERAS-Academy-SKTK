import { useState } from "react";
import {
  getListBaselineVersionsQueryKey,
  getListManagedBaselinesQueryKey,
  getPreviewBaselinePublicationQueryKey,
  useCancelBaselineDraft,
  useListBaselineVersions,
  useListManagedBaselines,
  usePreviewBaselinePublication,
  usePublishBaselineVersion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitCompareArrows, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export function isBaselinePreviewConfirmed(confirmedFingerprint: string | null, currentFingerprint: string | undefined) {
  return Boolean(currentFingerprint && confirmedFingerprint === currentFingerprint);
}

export function BaselinePublicationGate() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [baselineId, setBaselineId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [cancellationReason, setCancellationReason] = useState("");
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);
  const baselines = useListManagedBaselines({
    query: { queryKey: getListManagedBaselinesQueryKey() },
  });
  const versions = useListBaselineVersions(baselineId, {
    query: { enabled: Boolean(baselineId), queryKey: getListBaselineVersionsQueryKey(baselineId) },
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

  const selectBaseline = (next: string) => {
    setBaselineId(next);
    setVersionId("");
    setCancellationReason("");
    setConfirmedFingerprint(null);
  };

  const cancelSelectedDraft = () => {
    const reason = cancellationReason.trim();
    if (!versionId || !reason) return;
    cancel.mutate({ baselineId, versionId, data: { reason } }, {
      onSuccess: async result => {
        setConfirmedFingerprint(null);
        setVersionId("");
        setCancellationReason("");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListBaselineVersionsQueryKey(baselineId) }),
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
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListBaselineVersionsQueryKey(baselineId) }),
          queryClient.invalidateQueries({ queryKey: getListManagedBaselinesQueryKey() }),
        ]);
        toast({ title: `Baseline v${result.version} dipublikasikan`, description: "Enrollment baru akan memakai versi ini; histori learner lama tetap dipin." });
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