---
name: React Query polling in Node DOM tests
description: Why a jsdom-based Node test may never start React Query polling, and how to keep its timers isolated.
---

React Query can classify a Node test as server-side at module import time, before a jsdom window is installed. Polling remains disabled even when the rendered component later sees a DOM. For tests that need to exercise a real polling interval, override its environment manager with a function returning false for the test and restore server mode afterward; use controlled timers rather than waiting for production intervals.

**Why:** A mounted page showed its first response but never issued its scheduled refresh in a Node component test. Once browser mode was enabled, the query cache's real garbage-collection timer kept the runner alive after assertions passed.

**How to apply:** Only for Node-based component tests that verify React Query polling. Unmount and clear the isolated query client in a finally block to release interval and cache timers.