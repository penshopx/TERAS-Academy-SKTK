import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./routes/learner.ts", import.meta.url), "utf8");
const timeline = source.slice(
  source.indexOf("async function pathwayTimeline"),
  source.indexOf("async function diagnosticView"),
);

test("capability timeline scopes causal child queries to learner-owned parents", () => {
  const scopedQueries = [
    ["diagnostic gaps", "diagnosticGapsTable.profileId, profileIds"],
    ["diagnostic recommendations", "diagnosticRecommendationsTable.profileId, profileIds"],
    ["evidence reviews", "evidenceReviewsTable.evidenceId, evidenceIds"],
    ["remediation plans", "remediationPlansTable.gapId, gapIds"],
    ["remediation activities", "remediationActivitiesTable.planId, planIds"],
    ["remediation events", "remediationEventsTable.activityId, activityIds"],
  ] as const;

  for (const [label, predicate] of scopedQueries) {
    assert.match(timeline, new RegExp(`where\\(inArray\\(${predicate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\)`), `${label} must be filtered by its learner-owned parent in SQL`);
  }

  assert.match(timeline, /diagnosticSessionsTable\.enrollmentId, context\.enrollment\.id/, "diagnostic sessions must be enrollment-scoped");
  assert.match(timeline, /learningTransitionEventsTable\.enrollmentId, context\.enrollment\.id/, "learning transitions must be enrollment-scoped");
  assert.doesNotMatch(timeline, /\.select\(\)\.from\((diagnosticGapsTable|diagnosticRecommendationsTable|evidenceReviewsTable|remediationPlansTable|remediationActivitiesTable|remediationEventsTable)\)(?![\s\S]{0,120}\.where)/, "causal child tables must not be read without a database predicate");
});