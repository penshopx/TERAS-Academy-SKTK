---
name: Post-lock snapshots
description: How PostgreSQL statement snapshots interact with contended row locks and mutable audit context.
---

Acquire a shared parent-row lock in its own SQL statement before reading mutable child history used to validate an audit event.

**Why:** Under READ COMMITTED, a statement that begins before waiting on a row lock keeps its original snapshot after the wait. A child-history subquery inside that same statement can therefore miss the transaction that just released the lock, even though serialization appeared correct.

**How to apply:** For trigger guards that serialize on a parent row, first lock the parent, then read the effective child history in a separate statement so PostgreSQL takes a fresh snapshot.