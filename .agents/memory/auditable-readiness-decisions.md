---
name: Auditable readiness decisions
description: Durable rules for versioned readiness policy and non-compensable safety decisions.
---

Readiness rules are published as immutable versions per pathway and optional competency unit. Every canonical evaluation records the exact rule version, evidence snapshot, blockers, reason, and evaluation time. Final learner-facing status is limited to `Not Ready`, `Developing`, or `Ready for Official Assessment`.

Critical safety failure always produces `Not Ready`, regardless of aggregate or unrelated unit scores. Diagnostic preparation remains separate from canonical readiness.

**Why:** Averages can hide unsafe performance, and mutable rules make historical decisions impossible to explain or audit.

**How to apply:** Add new policy by publishing a new version rather than editing history. Any new readiness input must appear in the persisted evidence snapshot and transparent learner/passport basis.