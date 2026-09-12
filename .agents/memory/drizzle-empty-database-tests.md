---
name: Drizzle empty database tests
description: Why clean-bootstrap integration tests need a disposable PostgreSQL database rather than only a non-public schema.
---

Use a real disposable database when an integration test must prove a Drizzle push from a completely empty installation.

**Why:** Drizzle Kit 0.31 introspects `public` even when the connection `search_path` targets an empty non-public schema. It can compare against the source database's public tables and then issue unqualified checks against the empty schema, so schema isolation does not faithfully simulate a new database.

**How to apply:** Reserve disposable databases for clean-bootstrap tests, require a test-only role with `CREATEDB`, generate a unique safe name, and force-drop the database in `finally`. Keep ordinary integration tests on cheaper isolated schemas.