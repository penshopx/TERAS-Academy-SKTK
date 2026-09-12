---
name: Causal parent ownership
description: Why learner ownership and transitive parent identity remain immutable for causal learning records.
---

Learner-owned historical records must not change learner identity, and transitive parents such as evidence reviews and remediation plans must not be reparented after creation.

**Why:** Validating only causal-junction writes is insufficient: a later parent update can silently turn a valid chain into a cross-learner chain and can race with link creation. These records are append-only history, so identity changes should be represented by a new record rather than mutation.

**How to apply:** When adding a learner-scoped parent to a causal junction, enforce ownership on junction insert/update and preserve every direct or transitive ownership edge against later reparenting. If event context depends on append-only parent history, protect both writes with the same parent lock and reject backdated or equal-time parent inserts that would reinterpret existing events.