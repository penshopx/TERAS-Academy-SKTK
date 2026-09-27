---
name: Private ledger cursors
description: Privacy-preserving keyset pagination for operational metrics over immutable records
---

Encrypt keyset cursors rather than base64-encoding or merely signing them when they contain stable private identifiers. Preserve the original PostgreSQL timestamp text in the cursor and in the comparison, rather than round-tripping it through JavaScript's millisecond-precision Date. Bind the cursor to a fixed, expiring reporting window.

**Why:** A signed cursor still reveals its contents; truncating microsecond timestamps at a page boundary can silently skip records that share the same millisecond.

**How to apply:** Use this for bounded read APIs over append-only ledgers where response privacy excludes record IDs and timestamps may have microsecond precision.