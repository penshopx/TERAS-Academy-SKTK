---
name: Hanging Node fixtures
description: How to make timeout fixtures remain alive reliably in the project's Node runtime.
---

Timeout fixtures must retain an active event-loop handle, such as an interval, while awaiting indefinitely. An unresolved top-level promise by itself is not a reliable simulation of a stuck process.

**Why:** The Node runtime can classify a bare unresolved top-level await as unsettled and terminate the process with an error, so the runner observes an ordinary command failure rather than exercising its timeout.

**How to apply:** When testing process timeouts, first write any execution marker, then await a promise backed by an active timer or another open handle. Let the runner terminate the process group.