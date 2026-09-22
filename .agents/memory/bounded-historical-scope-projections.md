---
name: Bounded historical scope projections
description: How to preserve all-history authorization semantics without making read cost grow with immutable snapshot history.
---

Maintain a normalized, trigger-updated union of governed scope with reference counts when authorization must include every current and historical snapshot. Read paths should query that bounded union rather than expand snapshot JSON repeatedly.

**Why:** Moving JSON parsing from the application into SQL reduces transfer size but does not bound database work; immutable terminal history still makes every request slower.

**How to apply:** Increment and decrement projection counts when mutable or immutable snapshot rows are inserted, changed, or removed. Keep aggregate status queries selective and prove their index path with deterministic query-plan checks.

Historical scope identifiers may outlive their active catalogue rows. Do not add a foreign key from the authorization projection to the mutable catalogue when that would discard or block preserved historical scope.