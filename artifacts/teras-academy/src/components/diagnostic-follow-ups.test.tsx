import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiagnosticFollowUps } from "./trainer/diagnostic-follow-ups";

const recommendation = {
  id: "recommendation-1",
  competencyUnitId: null,
  unitCode: "U-1",
  unitTitle: "Safety",
  kind: "practice",
  title: "Supervised isolation practice",
  rationale: "Close the safety gap",
  priority: "Critical",
  href: null,
  followUpReminder: { status: "planned" as const, timing: "overdue" as const },
  followUps: [{
    id: "follow-up-1",
    recommendationId: "recommendation-1",
    trainerId: "trainer-1",
    trainerName: "Trainer",
    status: "planned" as const,
    targetAt: "2026-09-01T12:00:00.000Z",
    note: "Book supervised practice",
    recordedAt: "2026-08-20T12:00:00.000Z",
  }],
};

test("marks overdue follow-ups and exposes status and target filters", () => {
  const queryClient = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={queryClient}><DiagnosticFollowUps items={[{
    learnerId: "learner-1",
    learnerName: "Learner",
    pathwayId: "pathway-1",
    pathwayName: "Pathway",
    baselineScore: 55,
    currentState: "Developing",
    completedAt: "2026-08-01T12:00:00.000Z",
    dimensionSummaries: {},
    gaps: [],
    recommendations: [recommendation],
    safetyFindings: [],
  }]} /></QueryClientProvider>);

  assert.match(markup, /data-testid="follow-up-reminder-overdue"/);
  assert.match(markup, /Filter recommendations by follow-up status/);
  assert.match(markup, /Filter recommendations by target date/);
  assert.match(markup, /data-testid="trainer-reminder-preferences"/);
  assert.match(markup, /Receive email reminders/);
  assert.match(markup, /Operational delivery settings only/);
});