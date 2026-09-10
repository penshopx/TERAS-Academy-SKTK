import { useMemo, useState } from "react";
import {
  exportAdminReadinessHistory,
  getListAdminReadinessHistoryQueryKey,
  type AdminReadinessEvaluation,
  type AdminPathway,
  type AdminUser,
  type ListAdminReadinessHistoryParams,
  useListAdminReadinessHistory,
} from "@workspace/api-client-react";
import { Download, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Props = {
  enabled: boolean;
  users: AdminUser[];
  pathways: AdminPathway[];
  errorMessage: (error: unknown) => string;
};

const statuses = ["Not Ready", "Developing", "Ready for Official Assessment"] as const;

export function ReadinessAuditHistory({ enabled, users, pathways, errorMessage }: Props) {
  const [learnerId, setLearnerId] = useState("");
  const [pathwayId, setPathwayId] = useState("");
  const [status, setStatus] = useState("");
  const [ruleVersion, setRuleVersion] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminReadinessEvaluation | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const params = useMemo<ListAdminReadinessHistoryParams>(() => ({
    ...(learnerId ? { learnerId } : {}),
    ...(pathwayId ? { pathwayId } : {}),
    ...(status ? { status: status as typeof statuses[number] } : {}),
    ...(ruleVersion ? { ruleVersion: Number(ruleVersion) } : {}),
    page,
    pageSize: 25,
  }), [learnerId, pathwayId, status, ruleVersion, page]);
  const history = useListAdminReadinessHistory(params, {
    query: { enabled, staleTime: 30_000, refetchOnMount: "always", queryKey: getListAdminReadinessHistoryQueryKey(params) },
  });
  const learners = users.filter(user => user.roles.includes("learner"));
  const totalPages = Math.max(1, Math.ceil((history.data?.total ?? 0) / 25));
  const exportParams = useMemo(() => ({
    ...(learnerId ? { learnerId } : {}),
    ...(pathwayId ? { pathwayId } : {}),
    ...(status ? { status: status as typeof statuses[number] } : {}),
    ...(ruleVersion ? { ruleVersion: Number(ruleVersion) } : {}),
  }), [learnerId, pathwayId, status, ruleVersion]);

  const download = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const payload = await exportAdminReadinessHistory(exportParams);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `readiness-audit-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  };

  return <div className="space-y-4" data-testid="admin-readiness-audit-history">
    <Card>
      <CardHeader>
        <CardTitle>Riwayat keputusan readiness</CardTitle>
        <p className="text-sm text-muted-foreground">Evaluasi immutable untuk pemeriksaan lintas waktu. Ekspor memuat snapshot lengkap sesuai filter aktif.</p>
      </CardHeader>
      <CardContent className="space-y-4">
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
            <select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }} className="h-10 rounded-md border bg-background px-3" data-testid="filter-readiness-status">
              <option value="">Semua status</option>
              {statuses.map(item => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Rule version
            <Input value={ruleVersion} onChange={event => { setRuleVersion(event.target.value); setPage(1); }} type="number" min="1" placeholder="Semua versi" data-testid="filter-readiness-rule-version" />
          </label>
          <div className="flex items-end">
            <Button className="w-full" variant="outline" onClick={download} disabled={exporting} data-testid="button-export-readiness-history">
              {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}Ekspor JSON
            </Button>
          </div>
        </div>
        {exportError !== null && <p className="text-sm text-destructive" role="alert">{errorMessage(exportError)}</p>}
        {history.isLoading && <div className="flex min-h-24 items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />Memuat riwayat…</div>}
        {history.error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{errorMessage(history.error)}</p>}
        {!history.isLoading && !history.error && !history.data?.items.length && <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Tidak ada evaluasi yang cocok dengan filter.</p>}
        {!!history.data?.items.length && <div className="divide-y rounded-md border">
          {history.data.items.map(item => <button key={item.id} type="button" onClick={() => setSelected(item)} className="grid w-full gap-2 p-4 text-left hover:bg-muted/40 md:grid-cols-[1fr_auto] md:items-center" data-testid={`row-readiness-history-${item.id}`}>
            <span>
              <span className="font-semibold">{item.learnerName} · {item.pathwayName}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{item.gateCode} · {item.gateName} · {new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.evaluatedAt))}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2"><Badge variant="outline">v{item.ruleVersion}</Badge><Badge variant={item.status === "Not Ready" ? "destructive" : "secondary"}>{item.status}</Badge><strong>{item.score}%</strong></span>
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
          <div className="flex flex-wrap gap-2"><Badge>{selected.status}</Badge><Badge variant="outline">Rule v{selected.ruleVersion}</Badge><Badge variant="outline">Skor {selected.score}%</Badge></div>
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