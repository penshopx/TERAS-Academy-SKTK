---
name: Workflow database isolation
description: How to avoid false browser-test conclusions when workflow and shell database environments differ.
---

Do not assume that database queries launched from the agent shell observe the same database used by a managed application workflow. In schema-isolated tests, excluded tables can resolve through PostgreSQL `search_path` to `public`, so exclusion is not isolation. Browser idempotency tests should hold a response after commit, wait for the commit signal, then reload before retrying.

**Why:** Managed workflows can resolve environment-scoped database configuration independently from agent shell commands, producing contradictory test observations. Excluded mutable tables can silently read and write a shared fallback schema. Destroying a socket is nondeterministic because a browser may transparently retry a POST before application code observes the failure.

**How to apply:** Keep browser test setup and assertions in one isolated service environment; never use shell-side database counts as an oracle until environment equivalence is established. Clone or create every mutable test table inside the isolated schema rather than excluding it. For post-commit response-loss scenarios, prefer a test-only hold signal followed by browser reload over raw socket destruction.