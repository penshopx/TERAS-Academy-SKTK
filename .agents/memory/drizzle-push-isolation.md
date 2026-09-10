---
name: Drizzle push isolation
description: Reliable integration testing rules for Drizzle schema pushes against PostgreSQL.
---

Run Drizzle push integration tests against a separate temporary database, not an alternate `search_path` in the application database. Treat output beginning with `error:` as failure even when the process exit status is zero.

**Why:** Drizzle can target the `public` schema despite a session `search_path`, and some push failures have been printed as errors while the command still exited successfully. Either behavior can produce a false-positive test or touch the wrong schema.

**How to apply:** For migration-order or reconciliation tests, create an isolated database, restore only the schema needed for the scenario, capture both push output and status, and drop the database in a cleanup trap.

For route integration tests that only need to exercise selected SQL migrations, an isolated schema is sufficient if its prerequisite table structures are cloned without data and the application connection uses that schema from process startup. Do not run Drizzle push for this variant; run the selected migration SQL against the isolated `search_path` and drop the schema in `finally`.