---
name: Disposable schema name limits
description: PostgreSQL identifier truncation constraints for generated disposable integration schemas.
---

Generated disposable schema names must fit within PostgreSQL's 63-byte identifier limit. Their suffix must be a compact lowercase UUID v4 (exactly 32 hexadecimal characters).

**Why:** PostgreSQL silently truncates longer identifiers. Short, empty, or identifier-unsafe suffixes can also weaken uniqueness across concurrent test processes even when the full name remains within the limit.

**How to apply:** When changing schema-name generation, preserve the suffix format and uniqueness budget, then reserve its bytes plus the separator before accepting the prefix.