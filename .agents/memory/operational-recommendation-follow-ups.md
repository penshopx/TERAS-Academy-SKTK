---
name: Operational recommendation follow-ups
description: Boundary between trainer operations and immutable diagnostic/readiness records.
---

Trainer status updates, targets, and notes for diagnostic recommendations must be append-only operational history. They must not update the diagnostic recommendation itself or trigger a readiness or certification decision.

**Why:** Diagnostic recommendations and readiness decisions are evidence-bearing records with different ownership and meaning. Mixing trainer workflow state into them would make later operational activity appear to rewrite the original diagnostic or alter readiness.

**How to apply:** Add new events for every trainer change, derive the current display state from the latest event, authorize writes against the learner's active server-side assignment, and keep readiness computation independent.