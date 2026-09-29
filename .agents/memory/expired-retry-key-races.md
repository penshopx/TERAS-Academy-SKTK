---
name: Expired retry-key races
description: Transaction ordering when reusing a retention-expired idempotency key during cleanup.
---

When accepting a new outcome under an expired retry key, retire the stale key in the writer transaction before inserting the replacement. Do not rely on concurrent retention cleanup to make an `ON CONFLICT DO NOTHING` insert wait for deletion.

**Why:** A concurrent delete can leave the old committed unique key visible to the insert, which may treat the new outcome as a duplicate and acknowledge it without counting it. A scoped delete in the writer transaction serializes on the old row lock when cleanup is already deleting it, while the new row remains protected from cleanup by its current day.

**How to apply:** For any retention-bound idempotency key reused for a genuinely new event, remove only the matching expired key inside the same transaction as the new key and aggregate write. Test the overlap with a database lock that proves the writer is waiting for cleanup before release.