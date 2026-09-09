---
name: Integration governance
description: Rules for integrating isolated TERAS work without duplicating or destabilizing canonical subsystems.
---

Inspect the current implementation and map proposed work against canonical sources before editing. New behavior must be additive and backward-compatible; do not introduce duplicate routes, schemas, tables, scoring engines, or state vocabularies.

**Why:** Parallel task merges can appear locally correct while recreating an existing subsystem or conflicting with another isolated change. Infrastructure disconnects can also be mistaken for code defects and trigger unnecessary refactors.

**How to apply:** Preserve the boundaries of work that is active elsewhere and leave verified subsystems closed unless a new requirement targets them. After every merge, run isolated checks followed by typecheck, relevant tests/build, and post-merge reconciliation. Diagnose infrastructure failures by rerunning before changing code; only edit when logs identify a code, contract, schema, migration, or test defect.