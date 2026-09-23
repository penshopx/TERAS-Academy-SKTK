---
name: Concurrent index retry safety
description: How to preserve usable indexes when a concurrent PostgreSQL build is interrupted.
---

When replacing a populated table's index with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, check for an invalid or unready same-name index first and remove it before retrying. Confirm the replacement is valid and ready before retiring the old index.

**Why:** A cancelled concurrent build can retain its name in the catalog while being unusable by the planner. `IF NOT EXISTS` alone then skips rebuilding it and can make a migration drop the only working index.

**How to apply:** Keep concurrent DDL outside transactions; in psql migrations, conditionally run the invalid-index cleanup using `\gexec`. Exercise the cancelled-build case in an isolated database as well as the normal replay case.