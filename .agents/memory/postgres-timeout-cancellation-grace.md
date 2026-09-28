---
name: PostgreSQL timeout cancellation grace
description: Why bounded database query watchdogs should not expire at the same instant as server-side statement timeouts.
---

When a PostgreSQL query has both a server-side statement timeout and a client-side watchdog, allow a short cancellation-response grace period before the watchdog destroys the connection.

**Why:** Matching deadlines race: the server may already have canceled the query, but the driver has not yet received the error. Destroying the connection at that instant prevents safe session reuse and can cause tests to fail intermittently.

**How to apply:** Keep the server timeout as the query execution limit, use a slightly later client deadline as protection against a stuck driver or network, and replace the client only if the later watchdog actually fires.