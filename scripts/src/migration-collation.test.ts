import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const diagnosticMigration = await readFile(
  new URL("../../lib/db/migrations/0020_diagnostic_single_active_session.sql", import.meta.url),
  "utf8",
);
const eventContextMigration = await readFile(
  new URL("../../lib/db/migrations/0033_enrollment_event_context.sql", import.meta.url),
  "utf8",
);
const resourceProgressMigration = await readFile(
  new URL("../../lib/db/migrations/0038_learning_resource_progress_context.sql", import.meta.url),
  "utf8",
);

const diagnosticTieBreakers = diagnosticMigration.match(
  /ORDER BY session\.progress DESC, session\.created_at ASC, session\.id COLLATE "C" ASC/g,
);
assert.equal(
  diagnosticTieBreakers?.length,
  2,
  "canonical diagnostic session ranking must use the same bytewise ID tie-breaker",
);
assert.doesNotMatch(
  diagnosticMigration,
  /ORDER BY session\.progress DESC, session\.created_at ASC, session\.id (?:ASC|DESC)/,
);

const eventPathwayTieBreakers = eventContextMigration.match(
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id COLLATE "C" DESC/g,
);
assert.equal(
  eventPathwayTieBreakers?.length,
  6,
  "every historical pathway winner in the event-context migration must use bytewise ID order",
);
assert.doesNotMatch(
  eventContextMigration,
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id (?:ASC|DESC)/,
);

assert.match(
  resourceProgressMigration,
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id COLLATE "C" DESC/,
);
assert.doesNotMatch(
  resourceProgressMigration,
  /ORDER BY selection\.sequence DESC, selection\.created_at DESC, selection\.id (?:ASC|DESC)/,
);

console.log("Migration text winner collation contracts passed");