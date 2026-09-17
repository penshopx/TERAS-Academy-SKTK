---
name: Scheduled cleanup cycle claims
description: Cross-instance schedulers need durable cycle ownership, not only overlap prevention.
---

For cleanup jobs that should run once per UTC cycle, atomically persist the cycle claim in the same transaction as the cleanup. A failed cleanup must roll back its claim, while a committed claim makes both overlapping and later invocations in that cycle skip.

**Why:** Transaction-scoped advisory locks prevent concurrent overlap only. Instances with offset startup schedules can each acquire the lock after the previous transaction commits and report duplicate executions for one logical cycle.

**How to apply:** Test three cases: overlapping invocations yield one execution, a sequential invocation in the same cycle skips, and a later UTC cycle executes.