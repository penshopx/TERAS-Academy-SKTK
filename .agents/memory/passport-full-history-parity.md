---
name: Passport full-history parity
description: How complete Passport exports preserve parity with the paginated learner view.
---

Complete Passport downloads must traverse the same cursor-based timeline pages exposed to learners and concatenate page items without re-sorting or rebuilding causal references through a separate export path.

**Why:** A separate unbounded export query can drift from what learners see at page boundaries, especially when timestamps tie or causal references evolve.

**How to apply:** Keep the ordinary Passport response paginated. For full-history views and downloads, follow `nextCursor` until exhaustion, preserve item order and shape exactly, and fail on repeated or invalid cursors.