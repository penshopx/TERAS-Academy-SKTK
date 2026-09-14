---
name: Selective query-plan fixtures
description: How to make PostgreSQL plan regression tests represent parent-scoped production lookups.
---

Query-plan fixtures for parent-scoped lookups must include substantial history outside the target parent, not only a long target history.

**Why:** PostgreSQL correctly prefers a sequential scan when nearly every row matches. Such a fixture cannot distinguish a missing or unused parent index from a sensible planner decision.

**How to apply:** Populate both representative target history and much larger non-target history, run `ANALYZE`, then assert the index identity and rows read rather than machine-dependent execution time.