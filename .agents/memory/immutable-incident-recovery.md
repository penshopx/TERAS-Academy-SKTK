---
name: Immutable incident recovery
description: How to preserve trainer reminder configuration audit history when a blocked delivery condition is fixed.
---

Record recovery as a separate audit event explicitly linked to each blocked incident, rather than updating or removing the original event. Serialize incident creation and preference repair for a trainer so an in-flight scheduler cannot record a stale active problem after the repair.

**Why:** A past blocked delivery remains an actual event even after the configuration is fixed. A trainer can later make another invalid revision; that new incident must stay active while the earlier one remains visibly resolved. Explicit incident links avoid guessing status from timestamps and do not require storing learner data or raw preference values in the audit.

**How to apply:** For future remediation of trainer configuration incidents, preserve the original audit row, link the recovery to its incident identity, and use a shared per-trainer transaction lock on both producer and repair paths.