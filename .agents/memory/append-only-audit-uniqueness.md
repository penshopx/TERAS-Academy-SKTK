---
name: Append-only audit uniqueness upgrades
description: Handling historical duplicates when adding a database invariant to immutable audit history.
---

When adding uniqueness to append-only audit history, stop the upgrade with a specific conflict message if historical duplicates exist. Do not automatically delete, merge, or rewrite the conflicting events.

**Why:** A deduplication step would destroy immutable evidence and conceal a possible prior multi-writer error. An explicit preflight keeps the database unchanged and gives operators a chance to investigate before deciding how to reconcile history.

**How to apply:** Run a duplicate preflight before schema reconciliation creates the unique index; keep the migration replayable for already-valid databases.