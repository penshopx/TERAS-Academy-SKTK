---
name: Disposable schema name limits
description: PostgreSQL identifier truncation constraints for generated disposable integration schemas.
---

Generated disposable schema names must fit within PostgreSQL's 63-byte identifier limit, including the runner's random suffix.

**Why:** PostgreSQL silently truncates longer identifiers. The resulting schema can differ from the isolation URL and can weaken uniqueness assumptions in cleanup contracts.

**How to apply:** When introducing or validating integration schema prefixes, budget for separators and generated suffixes before accepting the prefix.