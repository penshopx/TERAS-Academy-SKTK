import assert from "node:assert/strict";
import test from "node:test";
import { journeyVisualState } from "./journey-status";

test("Not Ready is always rendered as blocked, never complete", () => {
  assert.equal(journeyVisualState("Not Ready"), "blocked");
  assert.notEqual(journeyVisualState("Not Ready"), "complete");
});

test("explicit readiness success is rendered as complete", () => {
  assert.equal(journeyVisualState("Ready for Official Assessment"), "complete");
});

test("unknown and pending statuses do not become success by substring", () => {
  assert.equal(journeyVisualState("Already reviewed later"), "pending");
  assert.equal(journeyVisualState("Not started"), "pending");
});