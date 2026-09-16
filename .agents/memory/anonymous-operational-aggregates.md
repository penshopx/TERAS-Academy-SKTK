---
name: Anonymous operational aggregates
description: Privacy and consistency rules for centralized operational trend summaries.
---

Centralized operational summaries must store only coarse outcome dimensions and counts. Do not attach actor, learner, filter, record, or audit-content identity to aggregate rows. Retry deduplication keys must be opaque, generated independently per operation, and stored separately from aggregate dimensions.

**Why:** Cross-device trend review requires shared storage, but operational monitoring must not become a second copy of sensitive audit history. Network retries can otherwise count one outcome more than once, while meaningful idempotency keys could reintroduce identity or filter data.

**How to apply:** Derive time buckets and coarse groups on the server, enforce allowed dimensions in the database and request contract, restrict management summaries by role, and return the active thresholds with the summary. Claim an opaque key and update its aggregate in one transaction; retain and prune keys with their aggregates.