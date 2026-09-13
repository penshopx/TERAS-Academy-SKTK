import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReadinessAuditExportAlerts,
  readReadinessAuditExportAggregates,
  trackLearningAction,
  trackReadinessAuditExport,
  trackReadinessDecisionRecorded,
  trackReadinessQueueOpened,
  trackResourceOpened,
} from "./analytics";

type TestUmami = {
  track(name: string, data?: Record<string, string | number | boolean>): void;
};

function setTestWindow(umami?: TestUmami, extras: Record<string, unknown> = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { umami, ...extras },
  });
}

function clearTestWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

test.afterEach(clearTestWindow);

test("dispatches the anonymous learning action contract to the injected tracker", () => {
  const calls: Array<{
    name: string;
    data?: Record<string, string | number | boolean>;
  }> = [];

  setTestWindow({
    track(name, data) {
      calls.push({ name, data });
    },
  });

  trackLearningAction({
    action: "continue_learning",
    location: "learning_list_next_action",
    courseId: "course-1",
    moduleId: "module-2",
    lessonId: "lesson-3",
    activityId: "activity-4",
  });

  assert.deepStrictEqual(calls, [{
    name: "learning_action",
    data: {
      action: "continue_learning",
      location: "learning_list_next_action",
      course_id: "course-1",
      module_id: "module-2",
      lesson_id: "lesson-3",
      activity_id: "activity-4",
    },
  }]);
});

test("dispatches only the minimum anonymous resource-open contract", () => {
  const calls: Array<{
    name: string;
    data?: Record<string, string | number | boolean>;
  }> = [];

  setTestWindow({
    track(name, data) {
      calls.push({ name, data });
    },
  });

  trackResourceOpened({
    activityId: "activity-4",
    resourceId: "resource-5",
    resourceType: "PDF",
  });

  assert.deepStrictEqual(calls, [{
    name: "learning_resource_opened",
    data: {
      activity_id: "activity-4",
      resource_id: "resource-5",
      resource_type: "PDF",
      location: "lesson_activity_resources",
    },
  }]);
});

test("dispatches the anonymous readiness funnel contract without learner data", () => {
  const calls: Array<{
    name: string;
    data?: Record<string, string | number | boolean>;
  }> = [];

  setTestWindow({
    track(name, data) {
      calls.push({ name, data });
    },
  });

  trackReadinessQueueOpened({
    queueType: "trainer_evidence",
    pathway: "Solar PV Technician",
    hasBlocker: false,
  });
  trackReadinessDecisionRecorded({
    queueType: "trainer_evidence",
    pathway: "Solar PV Technician",
    hasBlocker: true,
    outcome: "needs_revision",
  });

  assert.deepStrictEqual(calls, [
    {
      name: "readiness_queue_opened",
      data: {
        queue_type: "trainer_evidence",
        pathway: "Solar PV Technician",
        has_blocker: false,
      },
    },
    {
      name: "readiness_decision_recorded",
      data: {
        queue_type: "trainer_evidence",
        pathway: "Solar PV Technician",
        has_blocker: true,
        outcome: "needs_revision",
      },
    },
  ]);
});

test("dispatches only export outcome and numeric record count", () => {
  const calls: Array<{
    name: string;
    data?: Record<string, string | number | boolean>;
  }> = [];
  setTestWindow({ track: (name, data) => calls.push({ name, data }) });

  trackReadinessAuditExport("started", 0);
  trackReadinessAuditExport("succeeded", 37);
  trackReadinessAuditExport("cancelled", 12);
  trackReadinessAuditExport("failed", 4);

  assert.deepStrictEqual(calls, [
    { name: "readiness_audit_export", data: { outcome: "started", record_count: 0 } },
    { name: "readiness_audit_export", data: { outcome: "succeeded", record_count: 37 } },
    { name: "readiness_audit_export", data: { outcome: "cancelled", record_count: 12 } },
    { name: "readiness_audit_export", data: { outcome: "failed", record_count: 4 } },
  ]);
});

test("alerts only when a large-export group meets sample and failure thresholds", async () => {
  const alerts = evaluateReadinessAuditExportAlerts([
    { periodStart: "2026-09-06", periodEnd: "2026-09-12", recordGroup: "1.000–4.999 record", outcome: "succeeded", count: 3 },
    { periodStart: "2026-09-06", periodEnd: "2026-09-12", recordGroup: "1.000–4.999 record", outcome: "failed", count: 2 },
    { periodStart: "2026-09-12", periodEnd: "2026-09-12", recordGroup: "5.000–9.999 record", outcome: "failed", count: 1 },
  ]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].recordGroup, "1.000–4.999 record");
  assert.equal(alerts[0].sampleSize, 5);
  assert.equal(alerts[0].failureRatio, 0.4);
  assert.match(alerts[0].explanation, /2 dari 5/);
});

test("aggregates repeated known-large pre-header failures but excludes small exports", () => {
  const values = new Map<string, string>();
  setTestWindow(undefined, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    dispatchEvent: () => true,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    trackReadinessAuditExport("failed", 1_500);
    trackReadinessAuditExport("failed", 20);
  }

  const aggregates = readReadinessAuditExportAggregates(undefined, new Date());
  const alerts = evaluateReadinessAuditExportAlerts(aggregates);
  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0].recordGroup, "1.000–4.999 record");
  assert.equal(aggregates[0].count, 5);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].failureRatio, 1);
});

test("keeps both UTC boundary days in the rolling seven-day export window", () => {
  const values = new Map<string, string>([[
    "teras:readiness-audit-export-aggregates:v1",
    JSON.stringify([
      { periodStart: "2026-09-07", periodEnd: "2026-09-07", recordGroup: "1.000–4.999 record", outcome: "failed", count: 2 },
      { periodStart: "2026-09-13", periodEnd: "2026-09-13", recordGroup: "1.000–4.999 record", outcome: "succeeded", count: 3 },
    ]),
  ]]);
  setTestWindow(undefined, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
    },
  });

  const aggregates = readReadinessAuditExportAggregates(undefined, new Date("2026-09-13T23:59:59.999Z"));
  const alerts = evaluateReadinessAuditExportAlerts(aggregates);

  assert.equal(aggregates.length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sampleSize, 5);
  assert.equal(alerts[0].failedCount, 2);
  assert.equal(alerts[0].failureRatio, 0.4);
});

test("excludes expired and future aggregates from export alert volume and ratio", () => {
  const values = new Map<string, string>([[
    "teras:readiness-audit-export-aggregates:v1",
    JSON.stringify([
      { periodStart: "2026-09-06", periodEnd: "2026-09-06", recordGroup: "1.000–4.999 record", outcome: "failed", count: 20 },
      { periodStart: "2026-09-07", periodEnd: "2026-09-07", recordGroup: "1.000–4.999 record", outcome: "succeeded", count: 3 },
      { periodStart: "2026-09-13", periodEnd: "2026-09-13", recordGroup: "1.000–4.999 record", outcome: "failed", count: 2 },
      { periodStart: "2026-09-14", periodEnd: "2026-09-14", recordGroup: "1.000–4.999 record", outcome: "failed", count: 20 },
    ]),
  ]]);
  setTestWindow(undefined, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
    },
  });

  const aggregates = readReadinessAuditExportAggregates(undefined, new Date("2026-09-13T12:00:00.000Z"));
  const alerts = evaluateReadinessAuditExportAlerts(aggregates);

  assert.equal(aggregates.length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sampleSize, 5);
  assert.equal(alerts[0].failedCount, 2);
  assert.equal(alerts[0].failureRatio, 0.4);
});

test("returns a safe empty state for malformed export aggregate storage", () => {
  const malformedValues = [
    "{not-json",
    JSON.stringify({ periodStart: "2026-09-13" }),
    JSON.stringify([
      { periodStart: "2026-02-30", periodEnd: "2026-02-30", recordGroup: "1.000–4.999 record", outcome: "failed", count: 5 },
      { periodStart: "2026-09-13", periodEnd: "2026-09-12", recordGroup: "1.000–4.999 record", outcome: "failed", count: 5 },
      { periodStart: "2026-09-13", periodEnd: "2026-09-13", recordGroup: "1.000–4.999 record", outcome: "failed", count: "5" },
    ]),
  ];

  for (const storedValue of malformedValues) {
    setTestWindow(undefined, {
      localStorage: {
        getItem: () => storedValue,
      },
    });
    const aggregates = readReadinessAuditExportAggregates(undefined, new Date("2026-09-13T12:00:00.000Z"));
    assert.deepStrictEqual(aggregates, []);
    assert.deepStrictEqual(evaluateReadinessAuditExportAlerts(aggregates), []);
  }
});

test("remains a safe no-op when the injected tracker is unavailable", () => {
  setTestWindow();

  assert.doesNotThrow(() => {
    trackLearningAction({
      action: "open_lesson",
      location: "course_lesson_list",
      courseId: "course-1",
      lessonId: "lesson-3",
    });
  });
});

test("does not interrupt learning when the injected tracker throws", () => {
  setTestWindow({
    track() {
      throw new Error("tracker unavailable");
    },
  });

  assert.doesNotThrow(() => {
    trackLearningAction({
      action: "complete_activity",
      location: "lesson_activity",
      courseId: "course-1",
      moduleId: "module-2",
      lessonId: "lesson-3",
      activityId: "activity-4",
    });
  });

  assert.doesNotThrow(() => {
    trackResourceOpened({
      activityId: "activity-4",
      resourceId: "resource-5",
      resourceType: "PDF",
    });
  });

  assert.doesNotThrow(() => {
    trackReadinessAuditExport("succeeded", 8);
  });
});