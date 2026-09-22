import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  exportAdminReadinessHistory,
  getListAdminReadinessHistoryQueryKey,
  ReadinessSummaryStatus,
  type AdminReadinessEvaluation,
  type AdminReadinessExport,
  type AdminPathway,
  type AdminUser,
  type ListAdminReadinessHistoryParams,
  type ReadinessSummaryStatus as ReadinessStatus,
  getGetAdminReadinessExportTrendsQueryKey,
  useGetAdminReadinessExportTrends,
  useListAdminReadinessHistory,
  useRecordAdminReadinessExportTrend,
} from "@workspace/api-client-react";
import { AlertTriangle, Download, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trackReadinessAuditExport } from "@/lib/analytics";
import { getReadinessPresentation } from "@/lib/readiness-presentation";

type Props = {
  enabled: boolean;
  users: AdminUser[];
  pathways: AdminPathway[];
  errorMessage: (error: unknown) => string;
};

const statuses: ReadinessStatus[] = Object.values(ReadinessSummaryStatus);
type ExportStatus = "idle" | "preparing" | "success" | "failed" | "cancelled";

export function ReadinessAuditStatusBadge({ status }: { status: unknown }) {
  const presentation = getReadinessPresentation(status);
  return <Badge variant={presentation.badgeVariant} data-readiness-presentation={presentation.badgeVariant}>{presentation.label}</Badge>;
}

type DownloadEnvironment = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createAnchor: () => Pick<HTMLAnchorElement, "href" | "download" | "click">;
};

type ExportRequest = (
  signal: AbortSignal,
  callbacks: {
    onResponse: (response: Response) => void;
    onDownloadProgress: (progress: { loadedBytes: number; totalBytes: number | null }) => void;
  },
) => Promise<AdminReadinessExport>;

export async function runReadinessAuditExport({
  controller,
  request,
  download,
  initialRecordCount = 0,
  onRecordCount,
  onLoadedBytes,
}: {
  controller: AbortController;
  request: ExportRequest;
  download: (payload: AdminReadinessExport) => { checksum: string };
  initialRecordCount?: number;
  onRecordCount: (count: number) => void;
  onLoadedBytes: (loadedBytes: number) => void;
}): Promise<
  | { status: "success"; checksum: string; recordCount: number }
  | { status: "cancelled"; recordCount: number }
  | { status: "failed"; error: unknown; recordCount: number }
> {
  let recordCount = Math.max(0, initialRecordCount);
  try {
    const payload = await request(controller.signal, {
      onResponse: response => {
        const count = Number(response.headers.get("x-export-record-count"));
        if (Number.isInteger(count) && count >= 0) {
          recordCount = count;
          onRecordCount(count);
        }
      },
      onDownloadProgress: ({ loadedBytes }) => onLoadedBytes(loadedBytes),
    });
    if (controller.signal.aborted) {
      return { status: "cancelled", recordCount };
    }
    const downloaded = download(payload);
    onRecordCount(payload.recordCount);
    return { status: "success", checksum: downloaded.checksum, recordCount: payload.recordCount };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { status: "cancelled", recordCount };
    }
    return { status: "failed", error, recordCount };
  }
}

export function cancelReadinessExportOnUnmount(
  mounted: { current: boolean },
  controller: { current: AbortController | null },
) {
  mounted.current = false;
  controller.current?.abort();
  controller.current = null;
}

export function downloadReadinessAuditExport(
  payload: AdminReadinessExport,
  now = new Date(),
  environment: DownloadEnvironment = {
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
  },
) {
  const filename = `readiness-audit-${now.toISOString().slice(0, 10)}.json`;
  const files = [
    {
      filename,
      blob: new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    },
    {
      filename: `${filename}.canonical.sha256.txt`,
      blob: new Blob([
        `SHA-256 (payload canonical): ${payload.integrity.checksum}\n`,
        `File audit: ${filename}\n`,
        `Verifikasi: ${payload.integrity.verificationCommand}\n`,
      ], { type: "text/plain" }),
    },
  ];

  for (const file of files) {
    const url = environment.createObjectURL(file.blob);
    const anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    environment.revokeObjectURL(url);
  }

  return { filename, checksum: payload.integrity.checksum };
}

export function ReadinessExportFeedback({
  status,
  recordCount,
  error,
  errorMessage,
  checksum,
}: {
  status: ExportStatus;
  recordCount: number | null;
  error: unknown;
  errorMessage: (error: unknown) => string;
  checksum: string;
}) {
  return <>
    {status === "failed" && error !== null && <p className="text-sm text-destructive" role="alert">Ekspor gagal: {errorMessage(error)}</p>}
    {status === "cancelled" && <p className="rounded-md border p-3 text-sm" role="status" data-testid="readiness-export-cancelled">Ekspor dibatalkan. Tidak ada file yang diunduh.</p>}
    {status === "success" && <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm" role="status" data-testid="readiness-export-success">Ekspor berhasil. {recordCount ?? 0} record telah diunduh.</p>}
    {checksum && <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="readiness-export-checksum">
      <p className="font-medium">Checksum SHA-256 ekspor terakhir</p>
      <code className="mt-1 block break-all text-xs text-muted-foreground">{checksum}</code>
      <p className="mt-2 text-xs text-muted-foreground">File checksum canonical ikut diunduh. Verifikasi dengan <code>node artifacts/api-server/scripts/verify-readiness-audit.mjs &lt;file.json&gt;</code>.</p>
    </div>}
  </>;
}

const formatBytes = (bytes: number) => new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: bytes >= 1_000_000 ? 1 : 0,
}).format(bytes >= 1_000_000 ? bytes / 1_000_000 : bytes / 1_000) + (bytes >= 1_000_000 ? " MB" : " KB");

export function ReadinessExportProgress({
  recordCount,
  loadedBytes,
}: {
  recordCount: number | null;
  loadedBytes: number;
}) {
  return <div className="rounded-md border bg-muted/30 p-3 text-sm" role="status" aria-live="polite" data-testid="readiness-export-progress">
    <p className="font-medium">File sedang disiapkan</p>
    <p className="mt-1 text-muted-foreground">
      {recordCount === null ? "Menghitung record sesuai filter aktif…" : `${recordCount} record akan diekspor`}
      {loadedBytes > 0 ? ` · ${formatBytes(loadedBytes)} diterima` : ""}
    </p>
  </div>;
}

type ExportTrendOutcome = "succeeded" | "cancelled" | "failed";
type PendingExportOutcome = {
  attemptKey: string;
  outcome: ExportTrendOutcome;
  recordCount: number;
};
type OutcomeStorage = Pick<Storage, "getItem" | "setItem">;

export const READINESS_EXPORT_OUTCOME_QUEUE_KEY = "teras:readiness-export-outcomes:v1";

function isPendingExportOutcome(value: unknown): value is PendingExportOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 3
    && typeof item.attemptKey === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.attemptKey)
    && (item.outcome === "succeeded" || item.outcome === "cancelled" || item.outcome === "failed")
    && typeof item.recordCount === "number"
    && Number.isInteger(item.recordCount)
    && item.recordCount >= 0;
}

export function readPendingReadinessExportOutcomes(storage: OutcomeStorage): PendingExportOutcome[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(READINESS_EXPORT_OUTCOME_QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPendingExportOutcome) : [];
  } catch {
    return [];
  }
}

export function enqueueReadinessExportOutcome(storage: OutcomeStorage, outcome: PendingExportOutcome) {
  const pending = readPendingReadinessExportOutcomes(storage).filter(item => item.attemptKey !== outcome.attemptKey);
  storage.setItem(READINESS_EXPORT_OUTCOME_QUEUE_KEY, JSON.stringify([...pending, outcome]));
}

export async function flushPendingReadinessExportOutcomes(
  storage: OutcomeStorage,
  send: (outcome: PendingExportOutcome) => Promise<unknown>,
  onAccepted?: () => void,
) {
  for (const outcome of readPendingReadinessExportOutcomes(storage)) {
    try {
      await send(outcome);
      const remaining = readPendingReadinessExportOutcomes(storage)
        .filter(item => item.attemptKey !== outcome.attemptKey);
      storage.setItem(READINESS_EXPORT_OUTCOME_QUEUE_KEY, JSON.stringify(remaining));
      onAccepted?.();
    } catch {
      // Keep the same attempt queued for the next online or page-load retry.
    }
  }
}

export function readinessExportTrendInput(attemptKey: string, outcome: ExportTrendOutcome, recordCount: number) {
  return { data: { attemptKey, outcome, recordCount } };
}

export function ReadinessExportAlerts({
  alerts,
  periodDays,
  minimumSampleSize,
}: {
  alerts: Array<{
    periodStart: string;
    periodEnd: string;
    recordGroup: string;
    sampleSize: number;
    explanation: string;
  }>;
  periodDays: number;
  minimumSampleSize: number;
}) {
  if (alerts.length === 0) return null;
  return <section className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4" role="alert" data-testid="readiness-export-alerts">
    <div className="flex items-start gap-3">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
      <div className="min-w-0">
        <h3 className="font-semibold">Peringatan kegagalan ekspor besar</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Agregat anonim {periodDays} hari terakhir; minimum {minimumSampleSize} ekspor per kelompok.
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {alerts.map(alert => <li key={`${alert.periodStart}-${alert.recordGroup}`} className="rounded border border-amber-500/30 bg-background/60 p-3">
            <p className="font-medium">{alert.recordGroup}</p>
            <p className="text-muted-foreground">
              Periode {new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date(`${alert.periodStart}T00:00:00Z`))}–{new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date(`${alert.periodEnd}T00:00:00Z`))}
              {" · "}{alert.sampleSize} ekspor
            </p>
            <p className="mt-1"><span className="font-medium">Alasan: </span>{alert.explanation}</p>
          </li>)}
        </ul>
      </div>
    </div>
  </section>;
}

export function ReadinessAuditHistory({ enabled, users, pathways, errorMessage }: Props) {
  const [learnerId, setLearnerId] = useState("");
  const [pathwayId, setPathwayId] = useState("");
  const [status, setStatus] = useState<ReadinessStatus | "">("");
  const [ruleVersion, setRuleVersion] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminReadinessEvaluation | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportRecordCount, setExportRecordCount] = useState<number | null>(null);
  const [exportLoadedBytes, setExportLoadedBytes] = useState(0);
  const [exportError, setExportError] = useState<unknown>(null);
  const [lastChecksum, setLastChecksum] = useState("");
  const exportAbortController = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const recordExportTrend = useRecordAdminReadinessExportTrend();
  const recordExportTrendRef = useRef(recordExportTrend);
  const exporting = exportStatus === "preparing";
  const params = useMemo<ListAdminReadinessHistoryParams>(() => ({
    ...(learnerId ? { learnerId } : {}),
    ...(pathwayId ? { pathwayId } : {}),
    ...(status ? { status } : {}),
    ...(ruleVersion ? { ruleVersion: Number(ruleVersion) } : {}),
    page,
    pageSize: 25,
  }), [learnerId, pathwayId, status, ruleVersion, page]);
  const history = useListAdminReadinessHistory(params, {
    query: { enabled, staleTime: 30_000, refetchOnMount: "always", queryKey: getListAdminReadinessHistoryQueryKey(params) },
  });
  const exportTrends = useGetAdminReadinessExportTrends({
    query: { enabled, staleTime: 30_000, refetchOnMount: "always", queryKey: getGetAdminReadinessExportTrendsQueryKey() },
  });
  recordExportTrendRef.current = recordExportTrend;
  const learners = users.filter(user => user.roles.includes("learner"));
  const totalPages = Math.max(1, Math.ceil((history.data?.total ?? 0) / 25));
  const exportParams = useMemo(() => ({
    ...(learnerId ? { learnerId } : {}),
    ...(pathwayId ? { pathwayId } : {}),
    ...(status ? { status } : {}),
    ...(ruleVersion ? { ruleVersion: Number(ruleVersion) } : {}),
  }), [learnerId, pathwayId, status, ruleVersion]);

  useEffect(() => {
    mounted.current = true;
    return () => cancelReadinessExportOnUnmount(mounted, exportAbortController);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      void flushPendingReadinessExportOutcomes(
        window.localStorage,
        outcome => recordExportTrendRef.current.mutateAsync(
          readinessExportTrendInput(outcome.attemptKey, outcome.outcome, outcome.recordCount),
        ),
        () => {
          if (mounted.current) void exportTrends.refetch();
        },
      );
    };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [enabled, exportTrends.refetch]);

  const exportAlerts = exportTrends.data?.alerts ?? [];
  const recordFinalExportOutcome = (attemptKey: string, outcome: ExportTrendOutcome, recordCount: number) => {
    if (!enabled) return;
    const pending = { attemptKey, outcome, recordCount };
    try {
      enqueueReadinessExportOutcome(window.localStorage, pending);
      void flushPendingReadinessExportOutcomes(
        window.localStorage,
        item => recordExportTrendRef.current.mutateAsync(
          readinessExportTrendInput(item.attemptKey, item.outcome, item.recordCount),
        ),
        () => {
          if (mounted.current) void exportTrends.refetch();
        },
      );
    } catch {
      void recordExportTrendRef.current.mutateAsync(readinessExportTrendInput(attemptKey, outcome, recordCount))
        .then(() => exportTrends.refetch())
        .catch(() => undefined);
    }
  };

  const download = async () => {
    const attemptKey = crypto.randomUUID();
    const controller = new AbortController();
    exportAbortController.current = controller;
    setExportStatus("preparing");
    setExportRecordCount(null);
    setExportLoadedBytes(0);
    setExportError(null);
    trackReadinessAuditExport("started", Math.max(0, history.data?.total ?? 0));
    const result = await runReadinessAuditExport({
      controller,
      request: (signal, callbacks) => exportAdminReadinessHistory(exportParams, { signal, ...callbacks }),
      download: downloadReadinessAuditExport,
      initialRecordCount: Math.max(0, history.data?.total ?? 0),
      onRecordCount: count => {
        if (mounted.current) setExportRecordCount(count);
      },
      onLoadedBytes: loadedBytes => {
        if (mounted.current) setExportLoadedBytes(loadedBytes);
      },
    });
    try {
      if (!mounted.current) return;
      if (result.status === "success") {
        trackReadinessAuditExport("succeeded", result.recordCount);
        recordFinalExportOutcome(attemptKey, "succeeded", result.recordCount);
        setLastChecksum(result.checksum);
        setExportRecordCount(result.recordCount);
        setExportStatus("success");
      } else if (result.status === "cancelled") {
        trackReadinessAuditExport("cancelled", result.recordCount);
        recordFinalExportOutcome(attemptKey, "cancelled", result.recordCount);
        setExportStatus("cancelled");
      } else {
        trackReadinessAuditExport("failed", result.recordCount);
        recordFinalExportOutcome(attemptKey, "failed", result.recordCount);
        setExportError(result.error);
        setExportStatus("failed");
      }
    } finally {
      if (exportAbortController.current === controller) exportAbortController.current = null;
    }
  };

  const cancelExport = () => exportAbortController.current?.abort();

  return <div className="space-y-4" data-testid="admin-readiness-audit-history">
    <Card>
      <CardHeader>
        <CardTitle>Riwayat keputusan readiness</CardTitle>
        <p className="text-sm text-muted-foreground">Evaluasi immutable untuk pemeriksaan lintas waktu. Ekspor memuat snapshot lengkap sesuai filter aktif.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {exportTrends.isLoading && <p className="text-sm text-muted-foreground" role="status">Memuat tren ekspor anonim…</p>}
        {exportTrends.error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">Tren ekspor anonim tidak tersedia saat ini.</p>}
        <ReadinessExportAlerts
          alerts={exportAlerts}
          periodDays={exportTrends.data?.thresholds.periodDays ?? 7}
          minimumSampleSize={exportTrends.data?.thresholds.minimumSampleSize ?? 5}
        />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" aria-label="Filter riwayat readiness">
          <label className="grid gap-1 text-sm">Learner
            <select value={learnerId} onChange={event => { setLearnerId(event.target.value); setPage(1); }} className="h-10 rounded-md border bg-background px-3" data-testid="filter-readiness-learner">
              <option value="">Semua learner</option>
              {learners.map(learner => <option key={learner.id} value={learner.id}>{learner.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Pathway
            <select value={pathwayId} onChange={event => { setPathwayId(event.target.value); setPage(1); }} className="h-10 rounded-md border bg-background px-3" data-testid="filter-readiness-pathway">
              <option value="">Semua pathway</option>
              {pathways.map(pathway => <option key={pathway.id} value={pathway.id}>{pathway.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Status
            <select value={status} onChange={event => { setStatus(event.target.value as ReadinessStatus | ""); setPage(1); }} className="h-10 rounded-md border bg-background px-3" data-testid="filter-readiness-status">
              <option value="">Semua status</option>
              {statuses.map(item => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Rule version
            <Input value={ruleVersion} onChange={event => { setRuleVersion(event.target.value); setPage(1); }} type="number" min="1" placeholder="Semua versi" data-testid="filter-readiness-rule-version" />
          </label>
          <div className="flex items-end gap-2">
            <Button className="w-full" variant="outline" onClick={download} disabled={exporting} data-testid="button-export-readiness-history">
              {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}{exporting ? "Menyiapkan…" : "Ekspor JSON"}
            </Button>
            {exporting && <Button variant="destructive" size="icon" onClick={cancelExport} aria-label="Batalkan ekspor" data-testid="button-cancel-readiness-export"><X className="h-4 w-4" /></Button>}
          </div>
        </div>
        {exporting && <ReadinessExportProgress recordCount={exportRecordCount} loadedBytes={exportLoadedBytes} />}
        <ReadinessExportFeedback status={exportStatus} recordCount={exportRecordCount} error={exportError} errorMessage={errorMessage} checksum={lastChecksum} />
        {history.isLoading && <div className="flex min-h-24 items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />Memuat riwayat…</div>}
        {history.error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{errorMessage(history.error)}</p>}
        {!history.isLoading && !history.error && !history.data?.items.length && <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Tidak ada evaluasi yang cocok dengan filter.</p>}
        {!!history.data?.items.length && <div className="divide-y rounded-md border">
          {history.data.items.map(item => <button key={item.id} type="button" onClick={() => setSelected(item)} className="grid w-full gap-2 p-4 text-left hover:bg-muted/40 md:grid-cols-[1fr_auto] md:items-center" data-testid={`row-readiness-history-${item.id}`}>
            <span>
              <span className="font-semibold">{item.learnerName} · {item.pathwayName}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{item.gateCode} · {item.gateName} · {new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.evaluatedAt))}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2"><Badge variant="outline">v{item.ruleVersion}</Badge><ReadinessAuditStatusBadge status={item.status} /><strong>{item.score}%</strong></span>
          </button>)}
        </div>}
        {!!history.data?.total && <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground">{history.data.total} evaluasi · Halaman {history.data.page} dari {totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1 || history.isFetching}>Sebelumnya</Button>
            <Button variant="outline" size="sm" onClick={() => setPage(current => Math.min(totalPages, current + 1))} disabled={page >= totalPages || history.isFetching}>Berikutnya</Button>
          </div>
        </div>}
      </CardContent>
    </Card>
    <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Detail evaluasi readiness</DialogTitle><DialogDescription>Snapshot ini disimpan saat keputusan dibuat dan tidak dihitung ulang.</DialogDescription></DialogHeader>
        {selected && <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-2"><ReadinessAuditStatusBadge status={selected.status} /><Badge variant="outline">Rule v{selected.ruleVersion}</Badge><Badge variant="outline">Skor {selected.score}%</Badge></div>
          <section><h3 className="font-semibold">Alasan keputusan</h3><p className="mt-1 text-muted-foreground">{selected.decisionReason}</p></section>
          <section><h3 className="font-semibold">Blocker</h3>{selected.blockers.length ? <ul className="mt-2 list-disc space-y-1 pl-5">{selected.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul> : <p className="mt-1 text-muted-foreground">Tidak ada blocker.</p>}</section>
          <section><h3 className="font-semibold">Assessment snapshot</h3><div className="mt-2 grid gap-2">{selected.inputEvidence.assessments.map(item => <div key={item.id} className="rounded border p-3"><strong>{item.id}</strong><p>Skor {item.score} · {item.completed ? "Selesai" : "Belum selesai"} · {item.criticalFailure ? "Critical failure" : "Tanpa critical failure"}</p></div>)}</div></section>
          <section><h3 className="font-semibold">Evidence snapshot</h3><div className="mt-2 grid gap-2">{selected.inputEvidence.evidence.map(item => <div key={item.requirementId} className="flex justify-between rounded border p-3"><span>{item.requirementId}</span><Badge variant={item.satisfied ? "default" : "destructive"}>{item.satisfied ? "Terpenuhi" : "Belum terpenuhi"}</Badge></div>)}</div></section>
          <section><h3 className="font-semibold">Open critical gaps</h3>{selected.inputEvidence.openCriticalGaps.length ? <ul className="mt-2 list-disc pl-5">{selected.inputEvidence.openCriticalGaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : <p className="mt-1 text-muted-foreground">Tidak ada critical gap terbuka.</p>}</section>
        </div>}
      </DialogContent>
    </Dialog>
  </div>;
}