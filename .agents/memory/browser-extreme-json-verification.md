---
name: Browser extreme JSON verification
description: Reliable real-browser fixtures for deeply nested portfolio documents.
---

Browser engines can parse and stringify nesting far beyond typical server-side recursion limits; depth alone does not establish that a document will be rejected.

**Why:** A real-browser check of a deeply nested document returned a checksum mismatch, contrary to the rejection assumed from unit-level reasoning.

**How to apply:** Check rejection fixtures against the target browser, and measure responsiveness during actual Worker activity rather than inferring it from the eventual validation result.