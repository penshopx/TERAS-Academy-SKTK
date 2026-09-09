---
name: Nested aggregate mutation audits
description: Data-integrity rules for partial updates and audit history on parent records with multiple child collections.
---

For admin-managed aggregates with independently editable child collections, PATCH must replace only collections explicitly present in the request. Omitted collections remain unchanged; an explicit empty collection clears only that collection.

**Why:** A shared delete-and-reinsert branch can silently erase unrelated traceability, while a parent-only audit record can hide consequential child changes such as removing a blocking safety rule.

**How to apply:** Lock the parent row, read the complete before aggregate, mutate each supplied collection independently, read the complete after aggregate, and insert the audit event within the same database transaction.