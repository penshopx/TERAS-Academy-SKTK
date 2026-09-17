#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

run_id="${TERAS_GATE_RUN_ID:-$(node -e 'process.stdout.write(require("crypto").randomUUID())')}"
tested_head="$(git rev-parse HEAD 2>/dev/null || true)"
candidate_sha="${TERAS_GATE_CANDIDATE_SHA:-$tested_head}"
dirty_tree="$(if [[ -n "$(git status --porcelain=v1)" ]]; then echo true; else echo false; fi)"
fingerprint_manifest="$(mktemp)"
trap 'rm -f "$fingerprint_manifest"' EXIT
git diff --binary HEAD -- . >"$fingerprint_manifest"
git ls-files --others --exclude-standard | awk '/^(artifacts|lib|scripts)\// && /\.(c|m|j|t|s|yml|yaml|json|sh)$/ { print }' | sort |
  while IFS= read -r source_file; do
    printf '\nUNTRACKED:%s\n' "$source_file" >>"$fingerprint_manifest"
    sha256sum "$source_file" >>"$fingerprint_manifest"
  done
source_fingerprint="$(sha256sum "$fingerprint_manifest" | awk '{print $1}')"
report_dir="${TERAS_GATE_REPORT_DIR:-$repo_root/.release-gate}"
json_report="$report_dir/path-a-golden-journey-$run_id.json"
markdown_report="$report_dir/path-a-golden-journey-$run_id.md"
test_status="FAIL"
failure=""
mkdir -p "$report_dir"

write_report() {
  node - "$json_report" "$markdown_report" "$run_id" "$candidate_sha" "$tested_head" "$dirty_tree" "$source_fingerprint" "$test_status" "$failure" <<'NODE'
const fs = require("node:fs");
const [json, markdown, runId, sha, testedHead, dirtyTree, sourceFingerprint, status, failure] = process.argv.slice(2);
const releaseEligible = status === "PASS" && dirtyTree === "false" && sha === testedHead;
const report = {
  gate: "path-a-golden-journey",
  runId,
  candidateSha: sha,
  testedHead,
  dirtyTree: dirtyTree === "true",
  sourceFingerprint,
  releaseEligible,
  testStatus: status,
  gateReview: releaseEligible ? "PENDING" : "NO-GO",
  reviewer: null,
  reviewedAt: null,
  rationale: null,
  database: { isolated: true },
  checks: [{ name: "Path A Golden Journey", status, detail: failure || "authorized production route chain completed" }],
  failure,
};
fs.writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(markdown, [
  "# Path A Golden Journey release gate",
  "",
  `- Run: \`${runId}\``,
  `- Release candidate SHA: \`${sha}\``,
  `- Tested HEAD: \`${testedHead}\``,
  `- Worktree dirty: **${dirtyTree}**`,
  `- Source fingerprint (SHA-256): \`${sourceFingerprint}\``,
  `- Automated test status: **${status}**`,
  `- Release eligibility: **${releaseEligible ? "eligible for human review" : "NO-GO (dirty or candidate mismatch/failing test)"}**`,
  `- Gate review: **${releaseEligible ? "PENDING" : "NO-GO"}** (tests never auto-approve release)`,
  "- Database: isolated disposable PostgreSQL database",
  "",
  "## Check",
  "",
  "| Check | Status | Detail |",
  "| --- | --- | --- |",
  `| Path A Golden Journey | ${status} | ${failure || "authorized production route chain completed"} |`,
  "",
  "This report records Path A capability evidence only. It is not an official competency or certification decision.",
].join("\n") + "\n");
NODE
}

cleanup() { write_report; rm -f "$fingerprint_manifest"; }
trap cleanup EXIT

[[ -n "${DATABASE_URL:-}" ]] || { failure="DATABASE_URL is required"; exit 1; }
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || { failure="TERAS_GATE_CANDIDATE_SHA must be a full 40-character Git commit SHA"; exit 1; }
[[ "$candidate_sha" == "$tested_head" ]] || { failure="TERAS_GATE_CANDIDATE_SHA does not match tested HEAD"; exit 1; }
command -v createdb >/dev/null || { failure="createdb is required"; exit 1; }
command -v dropdb >/dev/null || { failure="dropdb is required"; exit 1; }
command -v psql >/dev/null || { failure="psql is required"; exit 1; }
if rg -U -q '(?:db|tx)\.insert\s*\(\s*(?:gapsTable|gapEventsTable|remediationPlansTable|remediationActivitiesTable|remediationEventsTable)' artifacts/api-server/src/certification-preparation-journey.integration.ts; then
  failure="Path A journey contains a direct journey-stage insert"
  exit 1
fi

if ! output="$(bash scripts/path-a-golden-journey.integration.test.sh 2>&1)"; then
  failure="$(printf '%s' "$output" | tail -c 3800)"
  exit 1
fi
test_status="PASS"
if [[ "$dirty_tree" == "true" ]]; then
  failure="Automated journey passed, but the worktree is dirty; report is release-ineligible and NO-GO."
fi