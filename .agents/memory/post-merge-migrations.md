---
name: Non-interactive post-merge migrations
description: How to keep automatic post-merge schema reconciliation safe when Drizzle detects data-loss risks.
---

Automatic post-merge setup must branch on whether the application's anchor table exists. For an existing schema, preflight additive columns, backfill rows, and establish required constraints before the normal Drizzle push. For an empty database, skip table-specific preflight and let Drizzle create the schema before seeding. Do not rely on `drizzle-kit push --force` to suppress every prompt.

Post-merge reconciliation and demo fixtures are development-only operations. Catalogue seed and demo seed must remain separate; demo seed must fail closed in a production-like environment. The full seed is one database transaction, and concurrent post-merge runs must not overlap.

**Why:** With stdin closed, Drizzle 0.31 still attempted an interactive truncation prompt while adding a unique constraint and non-null pathway columns. Running that preflight unconditionally also failed on a clean database because its tables did not exist yet. Demo learner/readiness fixtures and mutating integration tests must never run against a production target, and a failed seed must not leave a partial capability record.

**How to apply:** Detect the anchor table with `to_regclass`. Register every ordered migration in both existing-schema preflight and post-push finalization; do not skip intermediate migration numbers. Run idempotent, data-preserving preflight SQL only when the anchor exists, then run ordinary schema push and the atomic seed. Refresh composite-library declaration output before API tests consume newly merged exports. Require an explicit demo mode, reject production-like execution before any mutation, serialize updates on one transaction client, and verify the full script with closed stdin.

Drizzle Kit 0.31 may print an interactive-prompt error while returning a successful process status. Post-merge automation must inspect push output for emitted errors instead of trusting exit status alone.

**Why:** A nullable unique key represented as a legacy partial index caused schema push to request destructive truncation without a TTY; the runner continued into later migrations because the command still exited successfully.

**How to apply:** Align legacy indexes with the table constraints represented by the current schema during preflight, capture schema-push output, and fail before protection migrations whenever that output reports an error.

Composite foreign-key targets should be represented as named `UNIQUE` constraints in both PostgreSQL migrations and the Drizzle schema, rather than as standalone unique indexes.

**Why:** After a schema-only dump, Drizzle can try to recreate a standalone unique index that already backs a composite foreign key, producing a relation-name collision or a failed drop due to dependent objects.

**How to apply:** For existing installations, convert the matching standalone index with `ADD CONSTRAINT ... UNIQUE USING INDEX ...` before schema push, and model the same key with `unique(...)` in Drizzle.

Never infer missing ownership or pathway history for real learner records during automatic upgrade. Automatic reconstruction is acceptable only for a specifically identified demo fixture whose provenance is known.

**Why:** Absence of history does not prove that a mismatched event represents a legitimate transition; broad inference can silently turn corrupt learner data into apparently valid audit history.

**How to apply:** Keep validation fail-closed for ordinary enrollments. Scope any automatic reconstruction to an explicit fixture identity, preserve source events, and prove both recovery and rejection behavior in isolated tests.

Isolated fixtures that seed baseline catalogue rows after cloning or creating a schema must run baseline-version materialization after the seed. Handcrafted migration fixtures must also include additive columns expected by the current Drizzle schema.

**Why:** Schema-only isolation copies structure but not published baseline rows. Once enrollment and pathway selection require immutable version pins, a successful catalogue seed alone still leaves those flows without an applicable published version.

**How to apply:** Preserve production's fail-closed behavior. Fix each isolated setup by ordering schema creation → catalogue seed → idempotent version materialization, rather than adding an application fallback for unversioned baselines.