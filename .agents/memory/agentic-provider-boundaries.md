---
name: Agentic provider boundaries
description: Governance rule for grounded TERAS agent outputs and third-party model data minimization.
---

TERAS agent providers may rank or select opaque, allowlisted fact codes derived from authorized aggregates. TERAS must render all displayed prose, actions, confidence, grounding, timestamps, and citations locally; provider output never becomes an authoritative claim.

**Why:** Free-form provider prose and provider-selected citations can turn unsupported statements into apparently grounded advice. Stable learner, pathway, record, or evidence identifiers and domain free text also create unnecessary privacy and prompt-injection exposure when sent to an external model.

**How to apply:** Build exact counts from canonical assignment, pathway, baseline, latest-record, and queue semantics before applying display limits. Send only bounded aggregate kinds/counts with per-run opaque codes. Require strict complete allowlist validation and fall back wholesale on any invalid response. Keep ledger references non-identifying and result summaries count-only.