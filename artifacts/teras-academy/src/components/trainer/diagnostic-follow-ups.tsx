import { AlertTriangle, ArrowUpRight, BellRing, CalendarClock, ClipboardList, History, ShieldAlert } from "lucide-react";
import { getGetTrainerDashboardQueryKey, getGetTrainerReminderPreferenceHistoryQueryKey, getGetTrainerReminderPreferencesQueryKey, type DiagnosticRecommendation, type TrainerDiagnosticFollowUp, useGetTrainerReminderPreferenceHistory, useGetTrainerReminderPreferences, useRecordDiagnosticRecommendationFollowUp, useUpdateTrainerReminderPreferences } from "@workspace/api-client-react";
import React, { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
const timeZones = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC"];

function ReminderPreferences() {
  const preferences = useGetTrainerReminderPreferences({
    query: {
      queryKey: getGetTrainerReminderPreferencesQueryKey(),
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });
  const history = useGetTrainerReminderPreferenceHistory({
    query: { queryKey: getGetTrainerReminderPreferenceHistoryQueryKey(), staleTime: 30_000 },
  });
  const mutation = useUpdateTrainerReminderPreferences();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [timeZone, setTimeZone] = useState("Asia/Jakarta");
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursStart, setQuietHoursStart] = useState("20:00");
  const [quietHoursEnd, setQuietHoursEnd] = useState("07:00");
  const [fullDayConfirmationOpen, setFullDayConfirmationOpen] = useState(false);
  const availability = preferences.data;
  const isFullDayQuietHours = quietHoursEnabled && quietHoursStart === quietHoursEnd;

  useEffect(() => {
    if (!preferences.data) return;
    setEmailEnabled(preferences.data.emailEnabled);
    setTimeZone(preferences.data.timeZone);
    setQuietHoursEnabled(Boolean(preferences.data.quietHoursStart && preferences.data.quietHoursEnd));
    setQuietHoursStart(preferences.data.quietHoursStart ?? "20:00");
    setQuietHoursEnd(preferences.data.quietHoursEnd ?? "07:00");
  }, [preferences.data]);

  const persist = (confirmFullDayQuietHours: boolean) => mutation.mutate({
    data: {
      emailEnabled,
      timeZone,
      quietHoursStart: quietHoursEnabled ? quietHoursStart : null,
      quietHoursEnd: quietHoursEnabled ? quietHoursEnd : null,
      confirmFullDayQuietHours,
    },
  }, {
    onSuccess: (updated) => {
      queryClient.setQueryData(getGetTrainerReminderPreferencesQueryKey(), updated);
      queryClient.invalidateQueries({ queryKey: getGetTrainerReminderPreferenceHistoryQueryKey() });
      toast({ title: "Reminder preferences saved", description: "The scheduler will use these settings for future email attempts." });
    },
    onError: () => toast({ title: "Preferences not saved", description: "Please check the settings and try again.", variant: "destructive" }),
  });
  const save = () => {
    if (isFullDayQuietHours) {
      setFullDayConfirmationOpen(true);
      return;
    }
    persist(false);
  };

  return (
    <section className="rounded-lg border border-border bg-background/40 p-4" data-testid="trainer-reminder-preferences">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><BellRing className="h-4 w-4" />Email reminder preferences</h3>
          <p className="mt-1 text-xs text-muted-foreground">Operational delivery settings only. They do not change follow-ups, diagnostic evidence, or readiness decisions.</p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="trainer-reminder-email" className="text-sm font-medium">Receive email reminders</label>
          <Switch id="trainer-reminder-email" checked={emailEnabled} onCheckedChange={setEmailEnabled} />
        </div>
      </div>
      {availability ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm" data-testid="trainer-reminder-delivery-status">
          <Badge variant={availability.deliveryStatus === "active" ? "secondary" : "outline"}>
            {availability.deliveryStatus === "active" ? "Delivery active" : availability.deliveryStatus === "disabled" ? "Delivery inactive" : "Delivery paused"}
          </Badge>
          <span className="text-muted-foreground">
            {availability.deliveryStatus === "active"
              ? `Email reminders may be sent now (${availability.timeZone}).`
              : availability.deliveryStatus === "disabled"
                ? "Email reminders are turned off."
                : availability.nextDeliveryAt
                  ? `Quiet hours are active. Delivery resumes ${new Intl.DateTimeFormat("en-GB", { timeZone: availability.timeZone, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(availability.nextDeliveryAt))}.`
                  : "Quiet hours are active."}
          </span>
        </div>
      ) : null}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <label htmlFor="trainer-reminder-time-zone" className="text-xs font-medium">Delivery time zone</label>
          <Select value={timeZone} onValueChange={setTimeZone}>
            <SelectTrigger id="trainer-reminder-time-zone"><SelectValue /></SelectTrigger>
            <SelectContent>{timeZones.map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1 pb-2 md:col-span-2">
          <div className="flex items-center gap-2">
            <Switch id="trainer-reminder-quiet-hours" checked={quietHoursEnabled} onCheckedChange={setQuietHoursEnabled} />
            <label htmlFor="trainer-reminder-quiet-hours" className="text-sm">Use quiet hours</label>
          </div>
          <p className="text-xs text-muted-foreground">If start and end are the same, reminders pause for the full 24 hours and saving requires confirmation.</p>
        </div>
        {quietHoursEnabled && <>
          <div className="space-y-1.5">
            <label htmlFor="trainer-reminder-quiet-start" className="text-xs font-medium">Quiet hours start</label>
            <Input id="trainer-reminder-quiet-start" type="time" value={quietHoursStart} onChange={(event) => setQuietHoursStart(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="trainer-reminder-quiet-end" className="text-xs font-medium">Quiet hours end</label>
            <Input id="trainer-reminder-quiet-end" type="time" value={quietHoursEnd} onChange={(event) => setQuietHoursEnd(event.target.value)} />
          </div>
          <div className="md:col-span-3">
            {isFullDayQuietHours ? (
              <div className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100" role="alert" data-testid="full-day-quiet-hours-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p><strong>This pauses reminders for the full 24 hours.</strong> With the same start and end time, there is no delivery window. Saving requires explicit confirmation.</p>
              </div>
            ) : null}
          </div>
        </>}
      </div>
      <Button className="mt-4" size="sm" onClick={save} disabled={preferences.isLoading || mutation.isPending}>
        {mutation.isPending ? "Saving…" : "Save reminder preferences"}
      </Button>
      <details className="mt-4 border-t border-border pt-4" data-testid="trainer-reminder-preference-history">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4" />
          View operational configuration history
          {history.data?.length ? <Badge variant="outline">{history.data.length}</Badge> : null}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">This history records email delivery configuration only. It is separate from diagnostic evidence, follow-ups, and readiness decisions.</p>
        {history.isLoading ? <p className="mt-3 text-sm text-muted-foreground">Loading configuration history…</p> : null}
        {history.isError ? <p className="mt-3 text-sm text-destructive">Configuration history could not be loaded.</p> : null}
        {history.data?.length === 0 ? <p className="mt-3 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">No saved configuration revisions yet.</p> : null}
        {history.data?.length ? (
          <ol className="mt-3 space-y-2">
            {history.data.map((revision, index) => (
              <li key={revision.id} className="rounded-md border border-border bg-background/60 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{index === 0 ? "Current configuration" : "Previous configuration"}</strong>
                  <time className="text-muted-foreground" dateTime={revision.recordedAt}>{new Date(revision.recordedAt).toLocaleString()}</time>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <span>Email: <strong className="text-foreground">{revision.emailEnabled ? "Enabled" : "Disabled"}</strong></span>
                  <span>Time zone: <strong className="text-foreground">{revision.timeZone}</strong></span>
                  <span>Quiet hours: <strong className="text-foreground">{revision.quietHoursStart && revision.quietHoursEnd ? revision.quietHoursStart === revision.quietHoursEnd ? `${revision.quietHoursStart}–${revision.quietHoursEnd} (full 24 hours)` : `${revision.quietHoursStart}–${revision.quietHoursEnd}` : "Off"}</strong></span>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </details>
      <AlertDialog open={fullDayConfirmationOpen} onOpenChange={setFullDayConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause reminders for the full 24 hours?</AlertDialogTitle>
            <AlertDialogDescription>
              The start and end times are both {quietHoursStart}. No email reminders will be sent while this configuration remains active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => persist(true)}
              data-testid="confirm-full-day-quiet-hours"
            >
              Confirm 24-hour pause
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

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
        <ReminderPreferences />
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