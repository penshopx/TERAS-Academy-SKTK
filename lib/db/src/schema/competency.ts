import { relations, sql } from "drizzle-orm";
import { boolean, check, date, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pathwaysTable, practiceTasksTable, evidenceRequirementsTable } from "./teras";
import { learningOutcomesTable } from "./lms";

const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  createdBy: text("created_by").notNull().default("system"),
};

/** Reusable, domain-neutral competency framework catalogue. */
export const competencyFrameworksTable = pgTable("teras_competency_frameworks", {
  id: text("id").primaryKey(), code: text("code").notNull(), name: text("name").notNull(),
  description: text("description").notNull(), domain: text("domain").notNull().default("general"),
  version: text("version").notNull().default("1.0"), status: text("status").notNull().default("draft"),
  authorityStatus: text("authority_status").notNull().default("INTERNAL_DRAFT"), ...audit,
}, table => [
  uniqueIndex("teras_competency_frameworks_code_version_unique").on(table.code, table.version),
  check("teras_competency_frameworks_authority_status_check", sql`${table.authorityStatus} IN ('INTERNAL_DRAFT','AUTHORITATIVE')`),
]);

export const competencyUnitsTable = pgTable("teras_competency_units", {
  id: text("id").primaryKey(), frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(), title: text("title").notNull(), description: text("description").notNull(),
  status: text("status").notNull().default("draft"), sequence: integer("sequence").notNull().default(1),
  qualificationLevel: integer("qualification_level"), ...audit,
}, table => [
  uniqueIndex("teras_competency_units_framework_code_unique").on(table.frameworkId, table.code),
  uniqueIndex("teras_competency_units_framework_sequence_unique").on(table.frameworkId, table.sequence),
  check("teras_competency_units_sequence_check", sql`${table.sequence} > 0`),
  check("teras_competency_units_qualification_level_check", sql`${table.qualificationLevel} IS NULL OR ${table.qualificationLevel} BETWEEN 1 AND 9`),
]);

/** Regulatory metadata is deliberately separate from authored competency content. */
export const regulatoryReferencesTable = pgTable("teras_regulatory_references", {
  id: text("id").primaryKey(), type: text("type").notNull(), issuer: text("issuer").notNull(),
  number: text("number").notNull(), year: integer("year").notNull(), title: text("title").notNull(),
  enactedDate: date("enacted_date").notNull(), effectiveDate: date("effective_date").notNull(),
  beritaNegara: text("berita_negara").notNull(), authorityRole: text("authority_role").notNull(),
  status: text("status").notNull().default("ACTIVE"), contentSha256: text("content_sha256").notNull(), ...audit,
}, table => [
  uniqueIndex("teras_regulatory_references_identity_unique").on(table.issuer, table.number, table.year),
  check("teras_regulatory_references_role_check", sql`${table.authorityRole} IN ('DOMAIN_AUTHORITY','REGULATORY_CONTEXT')`),
  check("teras_regulatory_references_status_check", sql`${table.status} IN ('ACTIVE','SUPERSEDED','RETIRED','DRAFT')`),
  check("teras_regulatory_references_sha256_check", sql`${table.contentSha256} ~ '^[0-9a-fA-F]{64}$'`),
]);

export const competencyFrameworkSourcesTable = pgTable("teras_competency_framework_sources", {
  id: text("id").primaryKey(), frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id, { onDelete: "cascade" }),
  regulatoryReferenceId: text("regulatory_reference_id").notNull().references(() => regulatoryReferencesTable.id),
  provenanceType: text("provenance_type").notNull().default("AUTHORITATIVE"), ...audit,
}, table => [
  uniqueIndex("teras_framework_sources_unique").on(table.frameworkId, table.regulatoryReferenceId),
  check("teras_framework_sources_provenance_check", sql`${table.provenanceType} IN ('AUTHORITATIVE','CONTEXT','INTERNAL_DRAFT')`),
]);

export const competencyElementsTable = pgTable("teras_competency_elements", {
  id: text("id").primaryKey(), unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(), title: text("title").notNull(), description: text("description").notNull(),
  sequence: integer("sequence").notNull().default(1), ...audit,
}, table => [
  uniqueIndex("teras_competency_elements_unit_code_unique").on(table.unitId, table.code),
  uniqueIndex("teras_competency_elements_unit_sequence_unique").on(table.unitId, table.sequence),
  check("teras_competency_elements_sequence_check", sql`${table.sequence} > 0`),
]);

export const competencyKuksTable = pgTable("teras_competency_kuks", {
  id: text("id").primaryKey(), elementId: text("element_id").notNull().references(() => competencyElementsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(), statement: text("statement").notNull(), sequence: integer("sequence").notNull().default(1), ...audit,
}, table => [
  uniqueIndex("teras_competency_kuks_element_code_unique").on(table.elementId, table.code),
  uniqueIndex("teras_competency_kuks_element_sequence_unique").on(table.elementId, table.sequence),
  check("teras_competency_kuks_sequence_check", sql`${table.sequence} > 0`),
]);

export const qualificationPackagesTable = pgTable("teras_qualification_packages", {
  id: text("id").primaryKey(), frameworkId: text("framework_id").notNull().references(() => competencyFrameworksTable.id, { onDelete: "cascade" }),
  level: integer("level").notNull(), ...audit,
}, table => [
  uniqueIndex("teras_qualification_packages_framework_level_unique").on(table.frameworkId, table.level),
  check("teras_qualification_packages_level_check", sql`${table.level} BETWEEN 1 AND 9`),
]);

export const qualificationPackageUnitsTable = pgTable("teras_qualification_package_units", {
  id: text("id").primaryKey(), packageId: text("package_id").notNull().references(() => qualificationPackagesTable.id, { onDelete: "cascade" }),
  unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id), category: text("category").notNull(), sequence: integer("sequence").notNull().default(1), ...audit,
}, table => [
  uniqueIndex("teras_qualification_package_units_unique").on(table.packageId, table.unitId),
  check("teras_qualification_package_units_category_check", sql`${table.category} IN ('CORE','ELECTIVE_A','ELECTIVE_B')`),
  check("teras_qualification_package_units_sequence_check", sql`${table.sequence} > 0`),
]);

export const pathwayCompetencyUnitsTable = pgTable("teras_pathway_competency_units", {
  id: text("id").primaryKey(), pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id, { onDelete: "cascade" }),
  unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  required: boolean("required").notNull().default(true), sequence: integer("sequence").notNull().default(1), ...audit,
}, table => [
  uniqueIndex("teras_pathway_competency_units_pathway_unit_unique").on(table.pathwayId, table.unitId),
  check("teras_pathway_competency_units_sequence_check", sql`${table.sequence} > 0`),
]);

/** Traceability edges intentionally keep each evidence type addressable. */
export const competencyUnitOutcomesTable = pgTable("teras_competency_unit_outcomes", {
  id: text("id").primaryKey(), unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  learningOutcomeId: text("learning_outcome_id").references(() => learningOutcomesTable.id), outcomeCode: text("outcome_code").notNull(), description: text("description").notNull(), verificationMethod: text("verification_method").notNull(), ...audit,
}, table => [uniqueIndex("teras_competency_unit_outcomes_unit_code_unique").on(table.unitId, table.outcomeCode)]);

export const competencyUnitPracticeTasksTable = pgTable("teras_competency_unit_practice_tasks", {
  id: text("id").primaryKey(), unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => practiceTasksTable.id, { onDelete: "cascade" }), required: boolean("required").notNull().default(true), ...audit,
}, table => [uniqueIndex("teras_competency_unit_practice_unique").on(table.unitId, table.taskId)]);

export const competencyUnitEvidenceRequirementsTable = pgTable("teras_competency_unit_evidence_requirements", {
  id: text("id").primaryKey(), unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  requirementId: text("requirement_id").notNull().references(() => evidenceRequirementsTable.id, { onDelete: "cascade" }), required: boolean("required").notNull().default(true), ...audit,
}, table => [uniqueIndex("teras_competency_unit_evidence_unique").on(table.unitId, table.requirementId)]);

export const competencyUnitSimulationsTable = pgTable("teras_competency_unit_simulations", {
  id: text("id").primaryKey(), unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(), instructions: text("instructions").notNull(), evidenceRequired: text("evidence_required").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(0), disclaimer: text("disclaimer").notNull().default("Internal simulation/preparation only; not an official assessment or certification."), ...audit,
}, table => [check("teras_competency_unit_simulations_duration_check", sql`${table.durationMinutes} >= 0`)]);

export const competencyUnitSafetyRulesTable = pgTable("teras_competency_unit_safety_rules", {
  id: text("id").primaryKey(), unitId: text("unit_id").notNull().references(() => competencyUnitsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(), rule: text("rule").notNull(), severity: text("severity").notNull().default("critical"),
  verificationEvidence: text("verification_evidence").notNull(), blocking: boolean("blocking").notNull().default(true), ...audit,
}, table => [uniqueIndex("teras_competency_unit_safety_code_unique").on(table.unitId, table.code)]);

export const competencyInsertSchemas = Object.fromEntries(Object.entries({
  competencyFrameworksTable, competencyUnitsTable, pathwayCompetencyUnitsTable, competencyUnitOutcomesTable,
  competencyUnitPracticeTasksTable, competencyUnitEvidenceRequirementsTable, competencyUnitSimulationsTable, competencyUnitSafetyRulesTable,
  regulatoryReferencesTable, competencyFrameworkSourcesTable, competencyElementsTable, competencyKuksTable, qualificationPackagesTable, qualificationPackageUnitsTable,
}).map(([name, table]) => [name, createInsertSchema(table).omit({ createdAt: true, updatedAt: true })]));
export type CompetencyFramework = typeof competencyFrameworksTable.$inferSelect;
export type CompetencyUnit = typeof competencyUnitsTable.$inferSelect;
export type InsertCompetencyFramework = z.infer<typeof competencyInsertSchemas.competencyFrameworksTable>;

export const competencyFrameworkRelations = relations(competencyFrameworksTable, ({ many }) => ({ units: many(competencyUnitsTable) }));
export const competencyUnitRelations = relations(competencyUnitsTable, ({ many }) => ({
  pathways: many(pathwayCompetencyUnitsTable), outcomes: many(competencyUnitOutcomesTable), practiceTasks: many(competencyUnitPracticeTasksTable),
  evidenceRequirements: many(competencyUnitEvidenceRequirementsTable), simulations: many(competencyUnitSimulationsTable), safetyRules: many(competencyUnitSafetyRulesTable),
}));