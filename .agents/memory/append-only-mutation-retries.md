---
name: Append-only mutation retries
description: Idempotency rule for commands that append an immutable record and related lifecycle transitions.
---

Commands that append an immutable domain record and related lifecycle events must claim their idempotency key inside the same database transaction before any secondary events are written. A matching retry returns the original result; a reused key with a different payload is rejected; a changed payload uses a new key.

**Why:** A response can be lost after commit. Retrying only the primary insert safely is insufficient when remediation, gap, notification, or other append-only transitions can still be duplicated.

**How to apply:** Scope the unique key to the target entity and authenticated actor, persist a canonical payload fingerprint, and append secondary events only when the primary idempotency claim inserts successfully.