---
name: Concurrent expected rejections
description: Preventing unhandled-rejection flakes in database race-condition tests.
---

Attach the rejection assertion immediately when starting a concurrent query that is expected to fail. Await that assertion after releasing the competing transaction lock.

**Why:** If the database rejects the query immediately after the lock is released, delaying the rejection handler until after the commit can let Node classify the promise as unhandled and terminate the test nondeterministically.

**How to apply:** In race fixtures, wrap the query promise in the expected-rejection assertion at creation time. Perform lock-wait synchronization and commit the competing transaction afterward, then await the already-observed assertion.