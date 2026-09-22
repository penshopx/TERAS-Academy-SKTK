---
name: Passport full-history parity
description: How complete Passport exports preserve parity with the paginated learner view.
---

Complete Passport downloads must traverse the same cursor-based timeline pages exposed to learners and concatenate page items without re-sorting or rebuilding causal references through a separate export path. Build the timeline snapshot once per request, then advance every cursor over that immutable snapshot instead of reloading history for each page.

**Why:** A separate unbounded export query can drift from what learners see at page boundaries, especially when timestamps tie or causal references evolve. Rebuilding the complete timeline for every cursor also makes full-history downloads grow quadratically with the number of pages.

**How to apply:** Keep the ordinary Passport response paginated. For full-history views and downloads, load one request-scoped snapshot, follow `nextCursor` over it until exhaustion, preserve item order and shape exactly, and fail on repeated or invalid cursors.