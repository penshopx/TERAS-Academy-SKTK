import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("keeps export tracking safe and timestamp-free when the device clock is invalid", () => {
  const calls: Array<{
    name: string;
    data?: Record<string, string | number | boolean>;
  }> = [];
  const RealDate = Date;

  setTestWindow({ track: (name, data) => calls.push({ name, data }) });
  globalThis.Date = class extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...(args.length === 0 ? [Number.NaN] : args));
    }

    static now() {
      return Number.NaN;
    }
  } as DateConstructor;

  try {
    assert.doesNotThrow(() => trackReadinessAuditExport("failed", 5_000));
    assert.deepStrictEqual(calls, [{
      name: "readiness_audit_export",
      data: { outcome: "failed", record_count: 5_000 },
    }]);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("device clock rollback cannot hide export outcomes after the clock is corrected", () => {
  const calls: Array<{
    name: string;
    data?: Record<string, string | number | boolean>;
  }> = [];
  const RealDate = Date;
  let fixedTime = RealDate.parse("1999-01-01T00:00:00.000Z");

  setTestWindow({ track: (name, data) => calls.push({ name, data }) });
  globalThis.Date = class extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...(args.length === 0 ? [fixedTime] : args));
    }

    static now() {
      return fixedTime;
    }
  } as DateConstructor;

  try {
    trackReadinessAuditExport("failed", 5_000);
    fixedTime = RealDate.parse("2026-09-16T12:00:00.000Z");
    trackReadinessAuditExport("succeeded", 5_000);

    assert.deepStrictEqual(calls, [
      {
        name: "readiness_audit_export",
        data: { outcome: "failed", record_count: 5_000 },
      },
      {
        name: "readiness_audit_export",
        data: { outcome: "succeeded", record_count: 5_000 },
      },
    ]);
  } finally {
    globalThis.Date = RealDate;
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