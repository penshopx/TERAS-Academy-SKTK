import { boolean, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { modulesTable, pathwaysTable } from "./teras";

const audit = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  createdBy: text("created_by").notNull().default("system"),
};

/** A versioned, shared curriculum baseline. Pathways select modules from this catalogue. */
export const learningBaselinesTable = pgTable("teras_learning_baselines", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  version: text("version").notNull().default("1.0"),
  status: text("status").notNull().default("active"),
  ...audit,
}, table => [uniqueIndex("teras_learning_baselines_code_version_unique").on(table.code, table.version)]);

/** One canonical definition for each M01-M10 record. */
export const baselineModulesTable = pgTable("teras_baseline_modules", {
  id: text("id").primaryKey(),
  baselineId: text("baseline_id").notNull().references(() => learningBaselinesTable.id),
  moduleId: text("module_id").notNull().references(() => modulesTable.id),
  sequence: integer("sequence").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  learningOutcome: text("learning_outcome").notNull(),
  evidenceId: text("evidence_id").notNull(),
  status: text("status").notNull().default("active"),
  ...audit,
}, table => [
  uniqueIndex("teras_baseline_modules_baseline_sequence_unique").on(table.baselineId, table.sequence),
  uniqueIndex("teras_baseline_modules_baseline_code_unique").on(table.baselineId, table.code),
  uniqueIndex("teras_baseline_modules_module_unique").on(table.moduleId),
]);

/** Additive pathway selection of a shared baseline module. */
export const pathwayBaselineModulesTable = pgTable("teras_pathway_baseline_modules", {
  id: text("id").primaryKey(),
  pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id),
  baselineModuleId: text("baseline_module_id").notNull().references(() => baselineModulesTable.id),
  sequence: integer("sequence").notNull(),
  required: boolean("required").notNull().default(true),
  status: text("status").notNull().default("active"),
  ...audit,
}, table => [
  uniqueIndex("teras_pathway_baseline_modules_pathway_module_unique").on(table.pathwayId, table.baselineModuleId),
  uniqueIndex("teras_pathway_baseline_modules_pathway_sequence_unique").on(table.pathwayId, table.sequence),
]);

/** Pathway-specific assessment, evidence, output and KPI contract for shared modules. */
export const pathwayModuleContractsTable = pgTable("teras_pathway_module_contracts", {
  id: text("id").primaryKey(),
  pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id),
  moduleId: text("module_id").notNull().references(() => modulesTable.id),
  assessmentId: text("assessment_id").notNull(),
  evidenceRequirementId: text("evidence_requirement_id").notNull(),
  gateCode: text("gate_code").notNull(),
  assessment: text("assessment").notNull(),
  evidence: text("evidence").notNull(),
  output: text("output").notNull(),
  kpi: text("kpi").notNull(),
  portfolio: text("portfolio").notNull(),
  ...audit,
}, table => [
  uniqueIndex("teras_pathway_module_contracts_pathway_module_unique").on(table.pathwayId, table.moduleId),
]);

/** Compatibility mapping for the original B01-B08 design catalogue. */
export const legacyModuleMappingsTable = pgTable("teras_legacy_module_mappings", {
  id: text("id").primaryKey(),
  legacyModuleId: text("legacy_module_id").notNull().references(() => modulesTable.id),
  baselineModuleId: text("baseline_module_id").notNull().references(() => baselineModulesTable.id),
  pathwayId: text("pathway_id").notNull().references(() => pathwaysTable.id),
  status: text("status").notNull().default("retired"),
  note: text("note").notNull(),
  ...audit,
}, table => [
  uniqueIndex("teras_legacy_module_mappings_legacy_baseline_unique").on(table.legacyModuleId, table.baselineModuleId),
]);

const tables = {
  learningBaselinesTable,
  baselineModulesTable,
  pathwayBaselineModulesTable,
  pathwayModuleContractsTable,
  legacyModuleMappingsTable,
};
export const baselineInsertSchemas = Object.fromEntries(
  Object.entries(tables).map(([name, table]) => [name, createInsertSchema(table).omit({ createdAt: true, updatedAt: true })]),
);
export type LearningBaseline = typeof learningBaselinesTable.$inferSelect;
export type BaselineModule = typeof baselineModulesTable.$inferSelect;
export type PathwayBaselineModule = typeof pathwayBaselineModulesTable.$inferSelect;
export type PathwayModuleContract = typeof pathwayModuleContractsTable.$inferSelect;
export type LegacyModuleMapping = typeof legacyModuleMappingsTable.$inferSelect;
export type InsertLearningBaseline = z.infer<typeof baselineInsertSchemas.learningBaselinesTable>;