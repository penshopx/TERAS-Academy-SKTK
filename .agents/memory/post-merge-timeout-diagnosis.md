---
name: Post-merge timeout diagnosis
description: How to interpret variable post-merge setup timeouts under concurrent workspace load.
---

When a long post-merge setup times out at different test stages on successive attempts, do not keep increasing the global timeout as though one specific test were proven stuck. A test that prints its success message can still leave the surrounding command alive; conversely, that same test may exit normally in isolation.

**Why:** Successive full runs exhausted progressively longer budgets at different stages, while isolated contract and policy checks completed. The available logs did not establish a deterministic test failure or a safe stage to skip.

**How to apply:** Inspect active processes and the last command, reproduce the suspected test separately, and retain the full validation suite. Prefer a specific bounded diagnosis before changing more timeouts or treating partial output as a completed setup.