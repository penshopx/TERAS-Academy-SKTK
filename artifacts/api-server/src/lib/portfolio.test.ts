import assert from "node:assert/strict";
import test from "node:test";
import { terminalPortfolioForPathway } from "./teras";

test("active Path A terminates in the Capability Portfolio", () => {
  assert.equal(
    terminalPortfolioForPathway({ id: "path-a", name: "Capability pathway", purpose: "capability-development" }),
    "Capability Portfolio",
  );
});

test("active Path B terminates in the Certification Readiness Portfolio", () => {
  assert.equal(
    terminalPortfolioForPathway({ id: "path-b", name: "Certification pathway", purpose: "pre-certification" }),
    "Certification Readiness Portfolio",
  );
});