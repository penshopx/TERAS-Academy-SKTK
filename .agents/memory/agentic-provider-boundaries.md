---
name: Agentic provider boundaries
description: Governance rule for grounded TERAS agent outputs and third-party model data minimization.
---

TERAS agent providers may rank or select opaque, allowlisted fact codes derived from authorized aggregates. TERAS must render all displayed prose, actions, confidence, grounding, timestamps, and citations locally; provider output never becomes an authoritative claim.

**Why:** Free-form provider prose and provider-selected citations can turn unsupported statements into apparently grounded advice. Stable learner, pathway, record, or evidence identifiers and domain free text also create unnecessary privacy and prompt-injection exposure when sent to an external model.

**How to apply:** Build exact counts from canonical assignment, pathway, baseline, latest-record, and queue semantics before applying display limits. Send only bounded aggregate kinds/counts with per-run opaque codes. Require strict complete allowlist validation and fall back wholesale on any invalid response. Keep ledger references non-identifying and result summaries count-only.

Passing architecture, isolation, and adversarial tests establishes an architectural baseline, not proof of stability in real operation. Before adding another agent, observe the first agent through privacy-preserving aggregate telemetry and establish an operational baseline.

**Why:** Test success cannot measure real provider latency, fallback frequency, usage distribution, or operational grounding anomalies. Telemetry must not become a second store of learner identities, evidence content, prompts, or domain records.

**How to apply:** Keep the current read-only foundation stable, measure only non-identifying run health and quality aggregates, review operational evidence, then explicitly lock the operational baseline before expanding to another agent capability.

The canonical operational metric gate requires at least 100 terminal real runs distributed across 14 calendar days. Initial thresholds are: completed rate at least 95%, failed rate at most 1%, fallback rate at most 5%, and p95 terminal latency at most 15 seconds.

**Why:** A small or short-lived sample can hide provider instability and usage variation. Fixed, versioned thresholds prevent the acceptance criteria from moving after results are observed.

**How to apply:** Only a qualifying production environment may pass the canonical metric gate. Development and test results remain NOT_READY. A metric PASS is necessary but does not itself prove privacy, authorization, append-only protection, or domain non-mutation; those require separate regression evidence before governance declares the operational baseline verified.