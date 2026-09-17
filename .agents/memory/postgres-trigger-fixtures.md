---
name: PostgreSQL trigger fixtures
description: Safe construction of database failure fixtures that use temporary PostgreSQL triggers.
---

PostgreSQL DDL such as `CREATE TRIGGER` does not accept query bind parameters inside the trigger predicate. For isolated integration tests, prefer a trigger scoped by stable event fields and remove it immediately after the failure assertion instead of interpolating runtime identifiers into DDL.

**Why:** Parameterized trigger creation can fail at the protocol layer before the intended API operation runs, while raw identifier interpolation creates unnecessary SQL-safety risk.

**How to apply:** When forcing a database write failure, run the test in an isolated schema, constrain the trigger with fixed columns such as action and entity type, and drop the trigger and function both after the assertion and in final cleanup.