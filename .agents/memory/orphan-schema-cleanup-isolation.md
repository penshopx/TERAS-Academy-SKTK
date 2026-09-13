---
name: Orphan schema cleanup isolation
description: Why stale integration-schema cleanup must not gate the current harness run.
---

Stale integration-schema cleanup must inspect every eligible orphan and report all failures, but cleanup failures must remain non-fatal to the integration run being started.

**Why:** A persistently undroppable orphan can otherwise block every later integration run, even when each new run can create and safely clean its own isolated schema.

**How to apply:** Keep per-schema lock release and failure reporting explicit, continue scanning after individual failures, and handle the aggregate cleanup result at the harness boundary without preventing current setup or tests.