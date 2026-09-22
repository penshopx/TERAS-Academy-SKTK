import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPermen6UnitCode, isQualificationLevel, validateQualificationPackage } from "./competency-policy";

describe("Path B competency policy", () => {
  it("accepts the 12-identity Permen 6 shape and rejects malformed codes", () => {
    assert.equal(isPermen6UnitCode("X.OOYYYOO.003.0"), true);
    assert.equal(isPermen6UnitCode("X.OOYYYOO.03.0"), false);
    assert.equal(isPermen6UnitCode("X.OOYYYOO.003.1"), false);
    assert.equal(isPermen6UnitCode("X.OOYYYOO.003"), false);
  });
  it("bounds qualification levels", () => {
    assert.equal(isQualificationLevel(1), true);
    assert.equal(isQualificationLevel(9), true);
    assert.equal(isQualificationLevel(0), false);
    assert.equal(isQualificationLevel(10), false);
    assert.equal(isQualificationLevel(1.5), false);
  });
  it("rejects empty packages and enforces the elective boundary across A and B", () => {
    assert.equal(validateQualificationPackage([]).valid, false);
    assert.equal(validateQualificationPackage([{ category: "CORE" }, { category: "ELECTIVE_A" }, { category: "CORE" }]).valid, true);
    assert.equal(validateQualificationPackage([{ category: "CORE" }, { category: "CORE" }, { category: "CORE" }, { category: "ELECTIVE_B" }]).valid, false);
  });
});