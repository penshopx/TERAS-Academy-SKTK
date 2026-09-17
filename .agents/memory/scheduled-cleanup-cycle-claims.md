---
name: Scheduled cleanup cycle claims
description: Cross-instance schedulers need durable cycle ownership, not only overlap prevention.
---

For cleanup jobs that should run once per UTC cycle, atomically persist the cycle claim in the same transaction as the cleanup. A failed cleanup must roll back its claim, while a committed claim makes both overlapping and later invocations in that cycle skip. Persist health and recovery state in shared storage too; process-local counters become contradictory across instances and disappear on restart.

**Why:** Transaction-scoped advisory locks prevent concurrent overlap only. Instances with offset startup schedules can each acquire the lock after the previous transaction commits and report duplicate executions for one logical cycle.

**How to apply:** Test overlapping invocations, a sequential skip in the same cycle, execution in a later cycle, same-cycle failure deduplication, and shared alarm recovery.