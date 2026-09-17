---
name: Drizzle index ordering parity
description: How clean-bootstrap integration tests should handle index definitions also owned by SQL migrations.
---

Treat the SQL migration as authoritative when a clean Drizzle schema push creates an index with a different NULL ordering. Remove the pushed index in the disposable database before applying an idempotent migration that otherwise uses `CREATE INDEX IF NOT EXISTS`.

**Why:** Drizzle can emit descending indexes with `NULLS LAST`, while PostgreSQL SQL using bare `DESC` defaults to `NULLS FIRST`. An idempotent migration then keeps the pushed index by name, and query-plan regression tests can scan thousands of rows despite appearing to use the expected index.

**How to apply:** In clean-bootstrap integration setup, compare the actual index definition with the migration contract. If the migration is authoritative and uses `IF NOT EXISTS`, drop only the disposable copy before applying that migration.