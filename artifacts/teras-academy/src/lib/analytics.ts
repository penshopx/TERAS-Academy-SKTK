type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    // Replit's deployment proxy injects Umami after analytics is enabled.
    window.umami?.track(name, data);
  } catch {
    // Analytics is optional and must never interrupt the learning journey.
  }
}

type LearningAction =
  | "continue_learning"
  | "start_course"
  | "open_lesson"
  | "start_activity"
  | "complete_activity";

type LearningLocation =
  | "learning_list_next_action"
  | "course_lesson_list"
  | "lesson_activity";

type LearningActionData = {
  action: LearningAction;
  location: LearningLocation;
  courseId: string;
  moduleId?: string;
  lessonId?: string;
  activityId?: string;
};

export function trackLearningAction({
  action,
  location,
  courseId,
  moduleId,
  lessonId,
  activityId,
}: LearningActionData): void {
  trackEvent("learning_action", {
    action,
    location,
    course_id: courseId,
    ...(moduleId ? { module_id: moduleId } : {}),
    ...(lessonId ? { lesson_id: lessonId } : {}),
    ...(activityId ? { activity_id: activityId } : {}),
  });
}

type ResourceOpenedData = {
  activityId: string;
  resourceId: string;
  resourceType: string;
};

export function trackResourceOpened({
  activityId,
  resourceId,
  resourceType,
}: ResourceOpenedData): void {
  trackEvent("learning_resource_opened", {
    activity_id: activityId,
    resource_id: resourceId,
    resource_type: resourceType,
    location: "lesson_activity_resources",
  });
}

type ReadinessQueueType =
  | "trainer_practice"
  | "trainer_evidence"
  | "assessor_readiness";

type ReadinessQueueOpenedData = {
  queueType: ReadinessQueueType;
  pathway: string;
  hasBlocker: boolean;
};

type ReadinessDecisionRecordedData = ReadinessQueueOpenedData & {
  outcome: string;
};

export function trackReadinessQueueOpened({
  queueType,
  pathway,
  hasBlocker,
}: ReadinessQueueOpenedData): void {
  trackEvent("readiness_queue_opened", {
    queue_type: queueType,
    pathway,
    has_blocker: hasBlocker,
  });
}

export function trackReadinessDecisionRecorded({
  queueType,
  pathway,
  hasBlocker,
  outcome,
}: ReadinessDecisionRecordedData): void {
  trackEvent("readiness_decision_recorded", {
    queue_type: queueType,
    pathway,
    has_blocker: hasBlocker,
    outcome,
  });
}

type ReadinessAuditExportOutcome = "started" | "succeeded" | "cancelled" | "failed";

export type ReadinessAuditExportAggregate = {
  periodStart: string;
  periodEnd: string;
  recordGroup: string;
  outcome: Exclude<ReadinessAuditExportOutcome, "started">;
  count: number;
};

export type ReadinessAuditExportAlertThresholds = {
  minimumRecordCount: number;
  minimumSampleSize: number;
  failureRatio: number;
  periodDays: number;
};

export type ReadinessAuditExportAlert = {
  periodStart: string;
  periodEnd: string;
  recordGroup: string;
  sampleSize: number;
  failedCount: number;
  failureRatio: number;
  explanation: string;
};

export const DEFAULT_READINESS_EXPORT_ALERT_THRESHOLDS: ReadinessAuditExportAlertThresholds = {
  minimumRecordCount: 1_000,
  minimumSampleSize: 5,
  failureRatio: 0.4,
  periodDays: 7,
};

const READINESS_EXPORT_AGGREGATES_KEY = "teras:readiness-audit-export-aggregates:v1";
export const READINESS_EXPORT_AGGREGATES_UPDATED = "readiness-audit-export-aggregates-updated";

export function getReadinessExportRecordGroup(recordCount: number): string {
  if (recordCount >= 10_000) return "10.000+ record";
  if (recordCount >= 5_000) return "5.000–9.999 record";
  if (recordCount >= 1_000) return "1.000–4.999 record";
  return "Di bawah 1.000 record";
}

export function evaluateReadinessAuditExportAlerts(
  aggregates: ReadinessAuditExportAggregate[],
  thresholds: ReadinessAuditExportAlertThresholds = DEFAULT_READINESS_EXPORT_ALERT_THRESHOLDS,
): ReadinessAuditExportAlert[] {
  const groups = new Map<string, ReadinessAuditExportAggregate[]>();
  for (const aggregate of aggregates) {
    if (aggregate.count <= 0 || aggregate.outcome === "succeeded" && aggregate.count <= 0) continue;
    const entries = groups.get(aggregate.recordGroup) ?? [];
    entries.push(aggregate);
    groups.set(aggregate.recordGroup, entries);
  }

  return [...groups.entries()].flatMap(([recordGroup, entries]) => {
    const sampleSize = entries.reduce((sum, entry) => sum + entry.count, 0);
    const failedCount = entries
      .filter(entry => entry.outcome === "failed" || entry.outcome === "cancelled")
      .reduce((sum, entry) => sum + entry.count, 0);
    const failureRatio = sampleSize === 0 ? 0 : failedCount / sampleSize;
    if (sampleSize < thresholds.minimumSampleSize || failureRatio < thresholds.failureRatio) return [];
    return [{
      periodStart: entries.reduce((earliest, entry) => entry.periodStart < earliest ? entry.periodStart : earliest, entries[0].periodStart),
      periodEnd: entries.reduce((latest, entry) => entry.periodEnd > latest ? entry.periodEnd : latest, entries[0].periodEnd),
      recordGroup,
      sampleSize,
      failedCount,
      failureRatio,
      explanation: `${failedCount} dari ${sampleSize} ekspor gagal atau dibatalkan (${Math.round(failureRatio * 100)}%), melewati ambang ${Math.round(thresholds.failureRatio * 100)}%.`,
    }];
  });
}

export function readReadinessAuditExportAggregates(
  thresholds: ReadinessAuditExportAlertThresholds = DEFAULT_READINESS_EXPORT_ALERT_THRESHOLDS,
  now = new Date(),
): ReadinessAuditExportAggregate[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(READINESS_EXPORT_AGGREGATES_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - thresholds.periodDays + 1);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    return stored.filter((item): item is ReadinessAuditExportAggregate =>
      typeof item?.periodStart === "string"
      && typeof item?.periodEnd === "string"
      && typeof item?.recordGroup === "string"
      && ["succeeded", "cancelled", "failed"].includes(item?.outcome)
      && Number.isInteger(item?.count)
      && item.count > 0
      && item.periodEnd >= cutoffDay);
  } catch {
    return [];
  }
}

function aggregateReadinessAuditExport(outcome: ReadinessAuditExportOutcome, recordCount: number): void {
  if (outcome === "started" || recordCount < DEFAULT_READINESS_EXPORT_ALERT_THRESHOLDS.minimumRecordCount) return;
  try {
    if (!window.localStorage) return;
    const today = new Date().toISOString().slice(0, 10);
    const recordGroup = getReadinessExportRecordGroup(recordCount);
    const aggregates = readReadinessAuditExportAggregates();
    const existing = aggregates.find(item =>
      item.periodStart === today && item.periodEnd === today
      && item.recordGroup === recordGroup && item.outcome === outcome);
    if (existing) existing.count += 1;
    else aggregates.push({ periodStart: today, periodEnd: today, recordGroup, outcome, count: 1 });
    window.localStorage.setItem(READINESS_EXPORT_AGGREGATES_KEY, JSON.stringify(aggregates));
    window.dispatchEvent(new Event(READINESS_EXPORT_AGGREGATES_UPDATED));
  } catch {
    // Anonymous operational aggregation is optional, like the analytics tracker.
  }
}

export function trackReadinessAuditExport(
  outcome: ReadinessAuditExportOutcome,
  recordCount: number,
): void {
  trackEvent("readiness_audit_export", {
    outcome,
    record_count: recordCount,
  });
  if (typeof window !== "undefined") aggregateReadinessAuditExport(outcome, recordCount);
}