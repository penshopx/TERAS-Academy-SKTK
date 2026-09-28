---
name: Passport download budget
description: Why oversized Passport downloads are rejected before timeline construction.
---

Single-file Passport downloads intentionally fail with a size error when the source history is extreme. Do not truncate the signed portfolio to fit a limit; the checksum and full-history parity must describe the complete document. The paginated Passport history remains available for browsing.

**Why:** The full timeline and verification payload can multiply memory pressure during parsing and serialization. A preflight database aggregate avoids bringing extreme histories into Node merely to discover they cannot be exported safely. PostgreSQL's stored tuple sizes are not a safe proxy for logical size because compressible TOAST values can expand dramatically on retrieval.

**How to apply:** For future export changes, measure logical/decompressed bytes before full timeline materialization and keep related reads scoped to the exporting learner. Preserve the signed v1 payload byte-for-byte for accepted downloads. If large-file support becomes necessary, design a separate bounded streaming approach rather than relaxing the budget without measurement.