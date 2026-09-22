---
name: Advisory lock isolation tests
description: How to make PostgreSQL advisory-lock scope tests deterministic and sensitive to overly broad lock keys.
---

Concurrency tests for scoped advisory locks must first prove that the request expected to block is actually waiting on the exact lock held by the fixture. Inspect `pg_locks` by joining the ungranted waiter to the granted holder on the advisory lock identity, rather than inferring contention from an unsettled promise or elapsed time.

**Why:** An unsettled request may simply be slow or may not have reached the lock. Isolation fixtures must also keep the dimension under test equal—for example, two learners on the same pathway—so a lock accidentally scoped only to that shared dimension causes the test to fail.

**How to apply:** Hold the intended advisory lock in a dedicated transaction, capture that transaction's backend PID, start the matching request, poll until PostgreSQL reports an ungranted waiter on the holder's exact lock, and only then assert that a request with a distinct intended lock completes before release.