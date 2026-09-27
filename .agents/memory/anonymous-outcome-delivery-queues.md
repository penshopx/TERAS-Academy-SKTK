---
name: Anonymous outcome delivery queues
description: Privacy and reliability rules for browser-persisted retries of anonymous operational outcomes.
---

Persist only the server idempotency key and the minimum anonymous outcome fields needed to replay a failed delivery. When the original reporting period matters, include an attempt-bound server-signed period proof obtained before the action starts. Reuse the same key and proof for every retry and remove the local item only after the server accepts it.

**Why:** Fire-and-forget delivery loses outcomes during prolonged outages or page closure, while storing identities, filters, or exported content would turn an anonymous operational queue into sensitive browser data. Device timestamps cannot establish the original period, and using the recovery day distorts trends.

**How to apply:** Use this rule for operational analytics or audit-outcome retries that must survive reloads. Flush on page load and connection recovery, validate stored shapes before replay, and rely on server-side idempotency for duplicate sends. Do not replay older queue formats without a trusted period into the current period; acknowledge authentic outcomes outside retention without recreating expired aggregates.