---
name: Causal journey release gates
description: Rules for trustworthy end-to-end readiness gates across remediation, reassessment, and handoff.
---

An end-to-end release gate must create state through the same authorized production commands and transitions used by real actors. Separate diagnostic and downstream suites are not proof of one longitudinal journey, and chronology alone is not causality.

**Why:** Seeded terminal state and disconnected suites allowed gates to pass while the originating diagnostic gap was not explicitly linked to learning, remediation, reassessment, and portfolio.

**How to apply:** Use one run-scoped learner and assert the same diagnostic profile, gap, and recommendation IDs across learning, practice, evidence, review, remediation, reassessment, readiness, and portfolio. Rejected and duplicate requests must prove no mutation.