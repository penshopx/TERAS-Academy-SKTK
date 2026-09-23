---
name: Drizzle index ordering parity
description: Why Drizzle and SQL migrations must explicitly agree on descending index NULL ordering.
---

Align descending index NULL ordering explicitly in both Drizzle declarations and authoritative SQL migrations; a disposable bootstrap should not need to remove an index before an idempotent migration can preserve a fast query plan.

**Why:** Drizzle can emit descending indexes with `NULLS LAST`, while PostgreSQL SQL using bare `DESC` defaults to `NULLS FIRST`. An idempotent migration keeps a mismatched pushed index by name, and query-plan regression tests can scan thousands of rows despite appearing to use the expected index.

**How to apply:** When a nullable descending index is defined in both sources, specify the same NULL ordering in each, including tie-breaker columns for exact definition parity. Verify the query plan on a clean disposable schema without dropping the pushed index.