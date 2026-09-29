import React from "react";
import type { AdminReadinessExportTrendSummaryRetentionCleanup } from "@workspace/api-client-react";
import { AlertTriangle } from "lucide-react";

function formatCleanupTime(value: string | null) {
  if (!value) return "Belum tercatat";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Waktu tidak tersedia"
    : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ReadinessCleanupStatus({ status }: { status: AdminReadinessExportTrendSummaryRetentionCleanup }) {
  const neverRun = !status.lastSuccessAt && !status.lastFailureAt;
  const warning = status.alertActive || status.scheduleDelayed;
  return <section
    className={`rounded-md border p-4 text-sm ${warning ? "border-destructive/60 bg-destructive/10" : neverRun ? "border-border bg-muted/30" : "border-emerald-500/40 bg-emerald-500/10"}`}
    role={warning ? "alert" : "status"}
    data-testid="readiness-cleanup-status"
  >
    <div className="flex items-start gap-3">
      {warning && <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />}
      <div className="space-y-2">
        <h3 className="font-semibold">Cleanup tren ekspor: {status.alertActive ? "Alarm kegagalan aktif" : status.scheduleDelayed ? "Jadwal terlambat" : neverRun ? "Belum ada hasil" : "Normal"}</h3>
        <p>
          {status.consecutiveFailures} kegagalan beruntun · Ambang alarm: {status.failureThreshold} kegagalan beruntun.
        </p>
        <p>{status.missedCycles} siklus UTC terlewat · Ambang keterlambatan: {status.missedCycleThreshold} siklus UTC.</p>
        {status.scheduleDelayed && <p>Tidak ada percobaan cleanup pada siklus yang terlewat. Periksa scheduler.</p>}
        <dl className="grid gap-x-5 gap-y-1 sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Keberhasilan terakhir</dt><dd>{formatCleanupTime(status.lastSuccessAt)}</dd></div>
          <div><dt className="text-muted-foreground">Kegagalan terakhir</dt><dd>{formatCleanupTime(status.lastFailureAt)}</dd></div>
        </dl>
      </div>
    </div>
  </section>;
}