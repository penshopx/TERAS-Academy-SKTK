---
name: Scheduled cleanup cycle claims
description: Cross-instance schedulers need durable cycle ownership, not only overlap prevention.
---

For cleanup jobs that should run once per UTC cycle, atomically persist the cycle claim in the same transaction as the cleanup. A failed cleanup must roll back its claim, while a committed claim makes both overlapping and later invocations in that cycle skip. Persist health and recovery state in shared storage too; process-local counters become contradictory across instances and disappear on restart.

**Why:** Transaction-scoped advisory locks prevent concurrent overlap only. Instances with offset startup schedules can each acquire the lock after the previous transaction commits and report duplicate executions for one logical cycle.

**How to apply:** Test overlapping invocations, a sequential skip in the same cycle, execution in a later cycle, same-cycle failure deduplication, and shared alarm recovery.

For exceptionally large backlogs, the cycle claim may stay uncommitted in an outer transaction while individual deletion batches commit on separate connections. Success and the claim commit only after every batch; if a later batch fails, earlier deletions remain but a same-day retry can resume because the claim rolls back. Keep any work done in the outer transaction small and independent from current-day writers.

**Why:** A single huge DELETE retains retry-key row locks for the whole backlog and delays outcome writes, whereas committing the claim before all batches would incorrectly mark an interrupted cycle as complete.

**How to apply:** Verify the first batch is visible while a later batch is paused, fresh outcome writes commit during the pause, and a failure after a committed batch leaves the claim uncommitted so retry finishes the remaining keys.

In lock-contention integration fixtures, do not depend on `pg_stat_activity.query` to identify the waiting statement: this environment can report it as an empty string even when the session is visibly blocked. Identify the waiter by `pg_blocking_pids(pid)` against the known holder backend, then confirm the second waiter is blocked by the first. If a trigger must fail only the first transaction, a PostgreSQL sequence can count attempts across rollback (unlike a transaction-local marker).

**Why:** Query-text matching timed out despite the expected advisory lock wait, and a trigger that unconditionally raised also rejected the rightful successor after rollback.

**How to apply:** Hold a fixture-only advisory lock after the transaction has claimed its cycle, observe the blocker chain by PID, and use nontransactional sequence state to limit the injected failure to the first trigger invocation.