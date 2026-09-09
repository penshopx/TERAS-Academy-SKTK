---
name: Diagnostic projection integrity
description: Rules for turning diagnostic responses into durable competency profiles without changing canonical readiness.
---

Complete a diagnostic into one immutable profile projection in a single locked database transaction. Normalize diagnostic scores to 0–100, calculate each dimension independently, and scope every critical safety flag to the competency unit linked to the triggering response. Recommendations must come from the framework's learning, practice, evidence, simulation, or safety mappings.

**Why:** Partial profile writes, global safety blocking, raw option scores, or generic recommendations make the Personal Readiness Map misleading and break the causal chain from competency unit to intervention.

**How to apply:** Any new diagnostic dimension, framework mapping, or completion behavior must preserve concurrent idempotency, learner/pathway isolation, content-free audit details, and the separation between diagnostic state and canonical TERAS readiness.