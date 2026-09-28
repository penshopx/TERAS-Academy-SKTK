---
name: Actionlint path sensitivity
description: Why contract tests should pass repository-relative workflow paths to the pinned actionlint WASM validator.
---

The pinned actionlint WASM linter can throw a memory-access-out-of-bounds error when the workflow filename argument is an absolute path, even though the same workflow validates successfully when named relative to the repository root.

**Why:** A release-workflow contract check failed before reaching its assertions solely because it passed an absolute path to the linter; rerunning the exact same source with a relative path succeeded.

**How to apply:** Run the validator from the repository root and pass a repository-relative workflow path, including in shell contract tests. Do not interpret the WASM crash as a YAML error without reproducing using a relative path.