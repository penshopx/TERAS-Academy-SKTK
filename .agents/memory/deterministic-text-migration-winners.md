---
name: Deterministic text migration winners
description: Ensures data migrations choose the same winning text identifier across PostgreSQL collation environments.
---

When a data migration uses a text identifier as the final tie-breaker for a winning row, apply an explicit bytewise collation rather than the database default.

**Why:** PostgreSQL databases can use different libc or ICU collations, so identical tied records can otherwise produce different upgrade results.

**How to apply:** Audit winner-producing `ORDER BY`, `DISTINCT ON`, ranking, and text min/max expressions. Use `COLLATE "C"` on the text tie-breaker and rehearse tied mixed-case IDs; exclude presentation ordering and non-text keys.