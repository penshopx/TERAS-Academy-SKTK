---
name: Retryable trainer revisions
description: Why practice items needing revision must remain actionable in the trainer queue.
---

Practice reviews with a needs-revision outcome must remain available in the trainer queue until a later reviewed outcome closes them.

**Why:** A server transaction may commit while its response is lost. If the needs-revision item disappears immediately, the trainer cannot reopen the saved draft after reload and resend the same idempotency key. Keeping it actionable also supports append-only follow-up feedback.

**How to apply:** Treat a reviewed outcome as terminal for the practice review queue. Treat submitted and needs-revision outcomes as actionable, and preserve draft-bound idempotency keys until the browser receives success.