import { getLearnerJourneyPage, useGetCapabilityPassport, type JourneyStep } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Award, ShieldCheck, FileText, Download } from "lucide-react";
import { LearnerCondition } from "@/components/learner-condition";
import { PassportRecord } from "@/components/passport-record";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { getReadinessPresentation } from "@/lib/readiness-presentation";

type DownloadDependencies = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createAnchor: () => { href: string; download: string; click: () => void };
};

export function downloadPortfolioExport(
  payload: Awaited<ReturnType<typeof import("@workspace/api-client-react").exportLearnerPortfolio>>,
  dependencies: DownloadDependencies = {
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
  },
) {
  const date = payload.exportedAt.slice(0, 10);
  const slug = payload.portfolio.terminalPortfolio === "Capability Portfolio" ? "capability-portfolio" : "certification-readiness-portfolio";
  const url = dependencies.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }));
  const anchor = dependencies.createAnchor();
  anchor.href = url;
  anchor.download = `${slug}-${date}.json`;
  anchor.click();
  dependencies.revokeObjectURL(url);
}

export default function Passport() {
  const { data: passport, isLoading, error } = useGetCapabilityPassport();
  const [isExporting, setIsExporting] = useState(false);
  const [timeline, setTimeline] = useState<JourneyStep[]>([]);
  const [timelineNextCursor, setTimelineNextCursor] = useState<string | null>(null);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);

  useEffect(() => {
    if (!passport) return;
    setTimeline(passport.timeline);
    setTimelineNextCursor(passport.timelineNextCursor);
  }, [passport]);

  const loadMoreTimeline = async () => {
    if (!timelineNextCursor) return;
    setIsLoadingTimeline(true);
    try {
      const page = await getLearnerJourneyPage({ cursor: timelineNextCursor, limit: 50 });
      setTimeline(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...page.items.filter(item => !known.has(item.id))];
      });
      setTimelineNextCursor(page.nextCursor);
    } catch {
      toast.error("Riwayat berikutnya tidak dapat dimuat. Coba lagi.");
    } finally {
      setIsLoadingTimeline(false);
    }
  };

  const exportPortfolio = async () => {
    setIsExporting(true);
    try {
      const { exportLearnerPortfolio } = await import("@workspace/api-client-react");
      const exported = await exportLearnerPortfolio();
      downloadPortfolioExport(exported);
      toast.success(`${exported.portfolio.terminalPortfolio} berhasil diunduh`, {
        description: `ID verifikasi: ${exported.documentId}`,
      });
    } catch {
      toast.error("Portfolio tidak dapat diunduh. Coba lagi.");
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) {
    return <div className="h-full flex items-center justify-center min-h-[50vh]"><Activity className="w-8 h-8 text-primary animate-pulse" /></div>;
  }

  if (error || !passport) {
    return <div className="text-destructive p-8 bg-destructive/10 rounded-lg border border-destructive/20 text-center font-mono">Failed to load capability record.</div>;
  }
  const readinessPresentation = getReadinessPresentation(passport.readiness.status);

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-6xl mx-auto pb-20">
      
      {/* Passport Header */}
      <Card className="cockpit-panel border-border/50 overflow-hidden relative bg-card/40 backdrop-blur-md shadow-2xl">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
        <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none mix-blend-screen">
          <Award className="w-64 h-64 text-foreground" />
        </div>
        <CardContent className="p-8 md:p-10 relative z-10">
          <div className="flex flex-col md:flex-row gap-8 items-start">
            <div className="w-32 h-32 shrink-0 rounded-xl bg-background border border-border/50 flex items-center justify-center text-6xl font-bold font-mono text-foreground shadow-2xl relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-b from-foreground/5 to-transparent pointer-events-none" />
              <div className="absolute top-1.5 left-1.5 w-1.5 h-1.5 bg-border rounded-full" />
              <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-border rounded-full" />
              <div className="absolute bottom-1.5 left-1.5 w-1.5 h-1.5 bg-border rounded-full" />
              <div className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 bg-border rounded-full" />
              {passport.learner.initials}
            </div>
            <div className="flex-1 space-y-5">
              <div>
                <div className="flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-3">
                  <ShieldCheck className="w-4 h-4" /> Longitudinal Capability Record
                </div>
                <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-foreground mb-2">{passport.learner.name}</h1>
                <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{passport.subtitle}</p>
                <p role="note" className="max-w-2xl rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium leading-relaxed text-foreground">
                  {passport.readinessDisclaimer}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground font-mono text-xs">
                  <span className="flex items-center gap-1.5 text-foreground/70"><FileText className="w-3.5 h-3.5" /> INTERNAL TERAS CAPABILITY RECORD</span>
                  <span className="text-border">•</span>
                  <span className="text-foreground/70">CURRENT CONTEXT: {passport.pathway.name}</span>
                </div>
                <div className="inline-flex items-center rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-bold uppercase tracking-wider text-primary" data-testid="terminal-portfolio">
                  Terminal portfolio: {passport.terminalPortfolio}
                </div>
                <div>
                  <Button type="button" onClick={exportPortfolio} disabled={isExporting} className="gap-2" data-testid="download-portfolio">
                    <Download className="h-4 w-4" />
                    {isExporting ? "Menyiapkan portfolio…" : `Unduh ${passport.terminalPortfolio}`}
                  </Button>
                  <p className="mt-2 max-w-xl text-xs text-muted-foreground">
                    File JSON memuat timeline, referensi evidence, snapshot readiness, tanggal ekspor, dan checksum SHA-256 untuk verifikasi integritas.
                  </p>
                  <Link href="/verify-portfolio" className="mt-2 inline-flex text-xs font-semibold text-primary hover:underline" data-testid="link-portfolio-verifier">
                    Buka verifier publik
                  </Link>
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-6 border-t border-border/50">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Designation</div>
                  <div className="text-sm font-semibold text-foreground">{passport.learner.role}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Organization</div>
                  <div className="text-sm font-semibold text-foreground">{passport.learner.organization || '—'}</div>
                </div>
                <div className="md:col-span-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Active Pathway</div>
                  <div className="text-sm font-semibold text-foreground">{passport.pathway.name}</div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <LearnerCondition owner="Learner" />

      <Card className="border-primary/30" data-testid="passport-readiness-basis">
        <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><ShieldCheck className="h-5 w-5 text-primary" />Dasar keputusan readiness</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><Badge variant={readinessPresentation.badgeVariant} className="px-3 py-1 text-sm">{readinessPresentation.label}</Badge><span className="font-mono text-xs text-muted-foreground">Rule v{passport.readiness.ruleVersion} · {new Date(passport.readiness.evaluatedAt).toLocaleString("id-ID")}</span></div>
          <p className="text-sm leading-relaxed text-muted-foreground">{passport.readiness.decisionReason}</p>
          {passport.readiness.blockers.length > 0 && <ul className="space-y-2 border-l-2 border-destructive pl-4 text-sm">{passport.readiness.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}>{blocker}</li>)}</ul>}
          <div className="grid gap-3 sm:grid-cols-3 text-sm"><div><strong>{passport.readiness.score}/100</strong><p className="text-muted-foreground">Current evidence score</p></div><div><strong>{passport.readiness.inputEvidence.evidence.filter(item => item.satisfied).length}/{passport.readiness.inputEvidence.evidence.length}</strong><p className="text-muted-foreground">Evidence requirements</p></div><div><strong>{passport.readiness.inputEvidence.openCriticalGaps.length}</strong><p className="text-muted-foreground">Critical safety gaps</p></div></div>
        </CardContent>
      </Card>

      <div className="mt-8">
        <PassportRecord timeline={timeline} achievements={passport.achievements} />
        {timelineNextCursor && (
          <div className="mt-6 flex justify-center">
            <Button type="button" variant="outline" onClick={loadMoreTimeline} disabled={isLoadingTimeline}>
              {isLoadingTimeline ? "Memuat riwayat…" : "Muat riwayat Passport berikutnya"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
