---
name: Post-merge timeout diagnosis
description: How to interpret variable post-merge setup timeouts under concurrent workspace load.
---

When a long post-merge setup times out at different test stages on successive attempts, do not infer that the last printed test is stuck. A test that prints its success message can still leave the surrounding command alive; conversely, that same test may exit normally in isolation. Keep the complete automatic suite; increase the total budget only with measured stage costs and retain per-stage timing for diagnosis.

**Why:** Successive full runs exhausted progressively longer budgets at different stages. An isolated admin integration run passed but took several minutes; restoring its disposable database schema alone took over a minute and the code guard also took tens of seconds, with no database blockers observed. The user explicitly chose complete automatic validation despite longer setup time.

**How to apply:** Inspect active processes and the last command, reproduce the suspected test separately, and read per-stage durations before adjusting the global budget. Never treat partial output as a completed setup.