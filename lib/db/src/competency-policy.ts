/**
 * Narrow, fail-closed rules for the first Path B regulatory slice.
 * This module intentionally does not contain official competency content.
 */
export const PERMEN6_UNIT_CODE_PATTERN = /^[A-Z]\.[A-Z0-9]{7}\.\d{3}\.0$/;

export function isPermen6UnitCode(value: string): boolean {
  return typeof value === "string" && PERMEN6_UNIT_CODE_PATTERN.test(value) &&
    value.replaceAll(".", "").length === 12;
}

export function isQualificationLevel(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 9;
}

export type PackageCategory = "CORE" | "ELECTIVE_A" | "ELECTIVE_B";

export function validateQualificationPackage(
  units: readonly { category: PackageCategory }[],
): { valid: true } | { valid: false; reason: string } {
  if (units.length === 0) return { valid: false, reason: "qualification package must contain units" };
  const electives = units.filter(unit => unit.category === "ELECTIVE_A" || unit.category === "ELECTIVE_B").length;
  if (electives * 100 < units.length * 30) {
    return { valid: false, reason: "elective units must be at least 30% of all units" };
  }
  return { valid: true };
}