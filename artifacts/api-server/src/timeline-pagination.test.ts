import assert from "node:assert/strict";
import test from "node:test";
import { decodeTimelineCursor, encodeTimelineCursor, timelinePage } from "./routes/learner";

test("timeline cursor preserves the chronological date and id boundary", () => {
  const boundary = { date: "2026-09-14T10:11:12.000Z", id: "event-z" };
  assert.deepEqual(decodeTimelineCursor(encodeTimelineCursor(boundary)), boundary);
});

test("timeline cursor rejects malformed and incomplete values", () => {
  assert.equal(decodeTimelineCursor("not-a-cursor"), null);
  assert.equal(decodeTimelineCursor(Buffer.from(JSON.stringify({ date: "invalid", id: "event" })).toString("base64url")), null);
});

test("timeline pages do not duplicate or skip records with the same timestamp", () => {
  const date = new Date("2026-09-14T10:11:12.000Z");
  const records = ["event-a", "event-b", "event-c", "event-d"].map(id => ({ id, date }));
  const first = timelinePage(records, 2);
  const cursor = decodeTimelineCursor(first.nextCursor!);
  assert.ok(cursor);
  const second = timelinePage(records, 2, cursor);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), records.map(item => item.id));
  assert.equal(second.nextCursor, null);
});