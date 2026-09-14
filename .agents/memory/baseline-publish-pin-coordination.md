---
name: Baseline publish and pin coordination
description: Concurrency and history rules for publishing curriculum baselines while enrolling or switching learners.
---

Baseline publication and enrollment/pathway version pinning must acquire the same transaction-scoped coordination lock before reading the active baseline pointer. Enrollment-specific locks come first, followed by the shared publish/pin lock. A reviewed publication impact must be bound to a canonical digest of both snapshots and every displayed cohort/enrollment aggregate, then revalidated in a serializable publish transaction.

**Why:** Locking only the baseline that appears applicable before publication leaves a discovery race: another baseline can become applicable while the learner pin is being selected. A shared coordination lock makes the selected immutable version and the enrollment/event write one consistent decision. Hashing snapshots alone can still approve materially stale impact information when cohort or enrollment state changes after review.

**How to apply:** Any new path that publishes a baseline or stores a learner baseline-version pin must join this lock protocol and perform pointer resolution plus the learner write in one database transaction. Pre-publication gates must classify membership, content, and order independently, include all rendered impact inputs in the digest, and recheck authorization after lock acquisition. Historical projections must read the stored pin rather than the mutable catalogue.