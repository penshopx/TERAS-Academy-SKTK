import { AlertTriangle, ArrowUpRight, CalendarClock, ClipboardList, ShieldAlert } from "lucide-react";
import { getGetTrainerDashboardQueryKey, type DiagnosticRecommendation, type TrainerDiagnosticFollowUp, useRecordDiagnosticRecommendationFollowUp } from "@workspace/api-client-react";
import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const statusLabels = { planned: "Planned", in_progress: "In progress", completed: "Completed" } as const;
const timingLabels = {
  all: "All target dates",
  overdue: "Overdue",
  due_soon: "Due within 7 days",
  scheduled: "Scheduled later",
  unscheduled: "No target date",
  completed: "Completed",
} as const;

const newDraftKey = () => crypto.randomUUID();

function ReminderBadge({ recommendation }: { recommendation: DiagnosticRecommendation }) {
  const timing = recommendation.followUpReminder?.timing;
  if (timing !== "overdue" && timing !== "due_soon") return null;
  return (
    <Badge
      variant={timing === "overdue" ? "destructive" : "secondary"}
      className={timing === "due_soon" ? "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-200" : undefined}
      data-testid={`follow-up-reminder-${timing}`}
    >
      <CalendarClock className="mr-1 h-3 w-3" />
      {timing === "overdue" ? "Overdue" : "Due within 7 days"}
    </Badge>
  );
}

function RecommendationFollowUp({ recommendation }: { recommendation: DiagnosticRecommendation }) {
  const followUps = recommendation.followUps ?? [];
  const latest = followUps[0];
  const [status, setStatus] = useState<keyof typeof statusLabels>(latest?.status ?? "planned");
  const [targetAt, setTargetAt] = useState(latest?.targetAt ? latest.targetAt.slice(0, 10) : "");
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newDraftKey);
  const mutation = useRecordDiagnosticRecommendationFollowUp();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const submit = () => {
    if (!note.trim()) {
      toast({ title: "Note required", description: "Add a short operational note before saving.", variant: "destructive" });
      return;
    }
    mutation.mutate({
      recommendationId: recommendation.id,
      data: { idempotencyKey, status, note: note.trim(), targetAt: targetAt ? new Date(`${targetAt}T12:00:00Z`).toISOString() : null },
    }, {
      onSuccess: () => {
        setNote("");
        setIdempotencyKey(newDraftKey());
        queryClient.invalidateQueries({ queryKey: getGetTrainerDashboardQueryKey() });
        toast({ title: "Follow-up recorded", description: "The recommendation history has been updated." });
      },
      onError: () => toast({ title: "Follow-up failed", description: "The update could not be recorded. Please try again.", variant: "destructive" }),
    });
  };

  return <div className="mt-3 space-y-3 border-t border-border pt-3">
    <div className="flex flex-wrap items-center gap-2">
      <ReminderBadge recommendation={recommendation} />
      <Badge variant={latest?.status === "completed" ? "secondary" : "outline"}>
        {latest ? statusLabels[latest.status] : "Not planned"}
      </Badge>
      {latest?.targetAt && <span className="text-xs text-muted-foreground">Target {new Date(latest.targetAt).toLocaleDateString()}</span>}
      {latest && <span className="text-xs text-muted-foreground">Updated by {latest.trainerName} · {new Date(latest.recordedAt).toLocaleString()}</span>}
    </div>
    {latest && <p className="text-xs text-muted-foreground">{latest.note}</p>}
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Select value={status} onValueChange={(value) => { setStatus(value as keyof typeof statusLabels); setIdempotencyKey(newDraftKey()); }}>
        <SelectTrigger aria-label={`Follow-up status for ${recommendation.title}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="planned">Planned</SelectItem>
          <SelectItem value="in_progress">In progress</SelectItem>
          <SelectItem value="completed">Completed</SelectItem>
        </SelectContent>
      </Select>
      <Input type="date" value={targetAt} onChange={(event) => { setTargetAt(event.target.value); setIdempotencyKey(newDraftKey()); }} aria-label={`Target date for ${recommendation.title}`} />
    </div>
    <Textarea value={note} maxLength={500} onChange={(event) => { setNote(event.target.value); setIdempotencyKey(newDraftKey()); }} placeholder="Who will follow up, what happens next, or what was completed…" aria-label={`Follow-up note for ${recommendation.title}`} />
    <Button size="sm" onClick={submit} disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Record follow-up"}</Button>
    {followUps.length > 1 && <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">View {followUps.length} recorded changes</summary>
      <ul className="mt-2 space-y-2">
        {followUps.map((entry) => <li key={entry.id} className="rounded border border-border p-2 text-xs">
          <strong>{statusLabels[entry.status]}</strong> · {entry.trainerName} · {new Date(entry.recordedAt).toLocaleString()}
          {entry.targetAt && <> · Target {new Date(entry.targetAt).toLocaleDateString()}</>}
          <p className="mt-1 text-muted-foreground">{entry.note}</p>
        </li>)}
      </ul>
    </details>}
  </div>;
}

export function DiagnosticFollowUps({ items }: { items: TrainerDiagnosticFollowUp[] }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [timingFilter, setTimingFilter] = useState<keyof typeof timingLabels>("all");
  const visibleItems = items.map((item) => ({
    ...item,
    recommendations: item.recommendations.filter((recommendation) => {
      const reminder = recommendation.followUpReminder ?? { status: null, timing: "unscheduled" };
      const statusMatches = statusFilter === "all"
        || (statusFilter === "not_started" && reminder.status === null)
        || reminder.status === statusFilter;
      return statusMatches && (timingFilter === "all" || reminder.timing === timingFilter);
    }),
  })).filter((item) => item.baselineScore == null || item.recommendations.length > 0);
  const visibleRecommendationCount = visibleItems.reduce((count, item) => count + item.recommendations.length, 0);

  return (
    <Card data-testid="trainer-diagnostic-follow-ups">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-4 w-4" />Learner diagnostic follow-up</CardTitle>
        <p className="text-sm text-muted-foreground">Baseline diagnostic, priority gaps, and recommended learning or practice for each assigned learner pathway.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2" aria-label="Follow-up filters">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="Filter recommendations by follow-up status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="not_started">Not planned</SelectItem>
              <SelectItem value="planned">Planned</SelectItem>
              <SelectItem value="in_progress">In progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={timingFilter} onValueChange={(value) => setTimingFilter(value as keyof typeof timingLabels)}>
            <SelectTrigger aria-label="Filter recommendations by target date"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(timingLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {visibleItems.map((item) => (
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
                    {item.recommendations.length ? <ul className="space-y-2">{item.recommendations.map((recommendation) => <li key={recommendation.id} className="rounded-md border border-border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{recommendation.kind}</Badge><strong>{recommendation.title}</strong></div><p className="mt-1 text-muted-foreground">{recommendation.rationale}</p>{recommendation.href && <Button asChild size="sm" variant="outline" className="mt-3"><a href={recommendation.href}>Open recommended step <ArrowUpRight className="ml-1 h-3 w-3" /></a></Button>}<RecommendationFollowUp recommendation={recommendation} /></li>)}</ul> : <p className="text-sm text-muted-foreground">No recommended steps recorded.</p>}
                  </div>
                </div>
              </>
            )}
          </section>
        ))}
        {!items.length && <p className="text-sm text-muted-foreground">No active learner pathway assignments are available.</p>}
        {items.length > 0 && visibleRecommendationCount === 0 && <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No recommendations match these follow-up filters.</p>}
      </CardContent>
    </Card>
  );
}