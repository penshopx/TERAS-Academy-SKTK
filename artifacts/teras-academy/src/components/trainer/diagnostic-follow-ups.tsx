import { AlertTriangle, ArrowUpRight, ClipboardList, ShieldAlert } from "lucide-react";
import type { TrainerDiagnosticFollowUp } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DiagnosticFollowUps({ items }: { items: TrainerDiagnosticFollowUp[] }) {
  return (
    <Card data-testid="trainer-diagnostic-follow-ups">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-4 w-4" />Learner diagnostic follow-up</CardTitle>
        <p className="text-sm text-muted-foreground">Baseline diagnostic, priority gaps, and recommended learning or practice for each assigned learner pathway.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => (
          <section key={`${item.learnerId}:${item.pathwayId}`} className="rounded-lg border border-border bg-background/40 p-4" data-testid={`diagnostic-follow-up-${item.learnerId}-${item.pathwayId}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{item.learnerName}</h3>
                <p className="text-xs text-muted-foreground">{item.pathwayName}</p>
              </div>
              {item.baselineScore == null
                ? <Badge variant="outline">Diagnostic not completed</Badge>
                : <div className="text-right"><div className="font-mono text-2xl font-bold">{item.baselineScore}</div><div className="text-[10px] uppercase text-muted-foreground">Baseline / 100</div></div>}
            </div>

            {item.baselineScore != null && (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(item.dimensionSummaries).map(([dimension, score]) => <Badge key={dimension} variant="secondary" className="font-normal">{dimension}: {Math.round(score)}</Badge>)}
                  {item.currentState && <Badge variant="outline">{item.currentState}</Badge>}
                </div>

                {item.safetyFindings.length > 0 && (
                  <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 p-3" data-testid={`diagnostic-safety-${item.learnerId}`}>
                    <div className="flex items-center gap-2 font-semibold text-destructive"><ShieldAlert className="h-4 w-4" />Critical safety finding</div>
                    {item.safetyFindings.map((finding) => <p key={finding.id} className="mt-1 text-sm">{finding.detail}</p>)}
                    <p className="mt-2 text-xs text-muted-foreground">Requires learning and supervised practice follow-up. This diagnostic finding is not certification, clearance, or a final readiness decision.</p>
                  </div>
                )}

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-500" />Priority gaps</h4>
                    {item.gaps.length ? <ul className="space-y-2">{item.gaps.map((gap) => <li key={gap.id} className="rounded-md border border-border p-3 text-sm"><div className="flex items-center justify-between gap-2"><strong>{gap.unitCode || gap.unitTitle}</strong><Badge variant={gap.severity === "Critical" ? "destructive" : "secondary"}>{gap.severity}</Badge></div><p className="mt-1 text-muted-foreground">{gap.diagnosis}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">No diagnostic gaps recorded.</p>}
                  </div>
                  <div>
                    <h4 className="mb-2 text-sm font-semibold">Recommended next steps</h4>
                    {item.recommendations.length ? <ul className="space-y-2">{item.recommendations.map((recommendation) => <li key={recommendation.id} className="rounded-md border border-border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{recommendation.kind}</Badge><strong>{recommendation.title}</strong></div><p className="mt-1 text-muted-foreground">{recommendation.rationale}</p>{recommendation.href && <Button asChild size="sm" variant="outline" className="mt-3"><a href={recommendation.href}>Open recommended step <ArrowUpRight className="ml-1 h-3 w-3" /></a></Button>}</li>)}</ul> : <p className="text-sm text-muted-foreground">No recommended steps recorded.</p>}
                  </div>
                </div>
              </>
            )}
          </section>
        ))}
        {!items.length && <p className="text-sm text-muted-foreground">No active learner pathway assignments are available.</p>}
      </CardContent>
    </Card>
  );
}