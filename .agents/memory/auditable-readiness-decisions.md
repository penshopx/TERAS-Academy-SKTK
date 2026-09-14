---
name: Auditable readiness decisions
description: Durable rules for versioned readiness policy and non-compensable safety decisions.
---

Readiness rules are published as immutable versions per pathway and optional competency unit. Every canonical evaluation records the exact rule version, evidence snapshot, blockers, reason, and evaluation time. Final learner-facing status is limited to `Not Ready`, `Developing`, or `Ready for Official Assessment`.

Critical safety failure always produces `Not Ready`, regardless of aggregate or unrelated unit scores. Diagnostic preparation remains separate from canonical readiness.

An unchanged canonical evaluation reuses its latest persisted snapshot rather than appending a duplicate decision. A changed input, blocker, score, rule version, or reason creates a new immutable event.

**Why:** Averages can hide unsafe performance, mutable rules make historical decisions impossible to explain or audit, and duplicate read-triggered events make Passport views and exports disagree despite unchanged evidence.

**How to apply:** Add new policy by publishing a new version rather than editing history. Any new readiness input must appear in the persisted evidence snapshot and transparent learner/passport basis. Treat identical repeated reads as the same decision snapshot.