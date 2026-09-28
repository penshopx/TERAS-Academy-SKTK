---
name: Operational dialog browser fixtures
description: Why a focused confirmation browser test still needs complete surrounding screen responses
---

Browser tests aimed at a confirmation dialog need valid response shapes for the enclosing workspace's default tabs and supporting panels, even when the test immediately switches to another tab.

**Why:** Default workspace content can render and fetch before navigation reaches the targeted dialog. An incomplete mock may crash the entire screen, falsely suggesting that the dialog or identity harness failed.

**How to apply:** When building a focused browser fixture, inspect the initially mounted parent screen's eager data consumers and supply their required arrays and nested objects, including inactive panels that remain mounted. Await an actual visible control instead of assuming network idle means React has finished rendering; a synchronous locator count can race hydration. Treat fixture-shape failures as test setup failures, not product bugs.