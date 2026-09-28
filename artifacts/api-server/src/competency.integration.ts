import { and, desc, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import {
  adminAuditEventsTable, competencyFrameworksTable, competencyUnitEvidenceRequirementsTable,
  competencyUnitOutcomesTable, competencyUnitPracticeTasksTable, competencyUnitSafetyRulesTable,
  competencyUnitSimulationsTable, competencyUnitsTable, db, evidenceRequirementsTable,
  modulesTable, pathwayCompetencyUnitsTable, pathwaysTable, pool, practiceTasksTable, programsTable,
} from "@workspace/db";
import { CreateAdminCompetencyUnitBody, UpdateAdminCompetencyUnitBody } from "@workspace/api-zod";
import { createIntegrationTestApp } from "./integration-test-app";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const suffix = crypto.randomUUID();
const id = (name: string) => `competency-integration-${name}-${suffix}`;
const ids = {
  program: id("program"), pathway: id("pathway"), module: id("module"),
  task: id("task"), evidence: id("evidence"), framework: id("framework"), unit: id("unit"),
};

let role: "learner" | "admin" = "admin";
const app = createIntegrationTestApp(() => ({ userId: id("admin"), role }));

async function run() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Competency integration migration may only run with NODE_ENV=test");
  }
  // Use the application's pool so PGOPTIONS/search_path and DATABASE_URL are
  // identical for bootstrap, fixtures, route transactions, and assertions.
  for (const migrationName of [
    "0016_competency_frameworks.sql",
    "0054_path_b_regulatory_competency_foundation.sql",
    "0058_skttk_integration_review_guards.sql",
    "0058_skttk_integration_review_guards.sql",
  ]) {
    const migrationUrl = new URL(`../../../lib/db/migrations/${migrationName}`, import.meta.url);
    await pool.query(await readFile(migrationUrl, "utf8"));
  }

  await db.insert(programsTable).values({
    id: ids.program, domain: "integration", name: "Competency test program",
    description: "Fixture", status: "active", createdBy: `test:${suffix}`,
  });
  await db.insert(pathwaysTable).values({
    id: ids.pathway, programId: ids.program, name: "Competency test pathway",
    type: "standard", outcome: "Outcome", status: "active", createdBy: `test:${suffix}`,
  });
  await db.insert(modulesTable).values({
    id: ids.module, programId: ids.program, pathwayId: ids.pathway, sequence: 1,
    code: `M-${suffix.slice(0, 8)}`, name: "Module", capability: "Capability",
    evidence: "Evidence", learningOutcomes: [], theory: [], createdBy: `test:${suffix}`,
  });
  await db.insert(practiceTasksTable).values({
    id: ids.task, moduleId: ids.module, title: "Practice", description: "Practice",
    mode: "guided", durationMinutes: 10, output: "Output", createdBy: `test:${suffix}`,
  });
  await db.insert(evidenceRequirementsTable).values({
    id: ids.evidence, moduleId: ids.module, code: `E-${suffix.slice(0, 8)}`,
    name: "Evidence", description: "Evidence", allowedTypes: ["text"], createdBy: `test:${suffix}`,
  });
  await db.insert(competencyFrameworksTable).values({
    id: ids.framework, code: `F-${suffix.slice(0, 8)}`, name: "Framework",
    description: "Fixture", domain: "integration", version: "1.0", status: "draft",
    createdBy: `test:${suffix}`,
  });

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== "string", "test server did not bind");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const assertStatus = async (response: Response, expected: number, message: string) => {
    if (response.status !== expected) {
      throw new Error(`${message}: received ${response.status}: ${await response.text()}`);
    }
    return response;
  };
  const safety = (code: string, rule = "Stop if unsafe") => ({
    code, rule, severity: "critical", verificationEvidence: "Supervisor check", blocking: true,
  });
  const simulation = { title: "Simulation", instructions: "Follow the procedure", evidenceRequired: "Record", durationMinutes: 15 };
  try {
    role = "learner";
    assert((await request("/admin/competency-frameworks")).status === 403, "learner must not list");
    assert((await request("/admin/competency-units", "POST", {
      id: ids.unit, frameworkId: ids.framework, code: "U-1", title: "Unit",
      description: "Unit", status: "draft", sequence: 1,
    })).status === 403, "learner must not create");
    assert((await request(`/admin/competency-units/${ids.unit}`, "PATCH", { safetyRules: [] })).status === 403, "learner must not update");

    role = "admin";
    const createBody = {
      id: ids.unit, frameworkId: ids.framework, code: "U-1", title: "Unit",
      description: "Unit", status: "draft", sequence: 1,
      pathwayIds: [ids.pathway],
      outcomeMappings: [{ learningOutcomeId: null, outcomeCode: "LO-1", description: "Outcome", verificationMethod: "TRAINER_REVIEW" }],
      practiceTaskIds: [ids.task], evidenceRequirementIds: [ids.evidence],
      simulations: [simulation], safetyRules: [safety("SAFE-1")],
    };
    await assertStatus(await request("/admin/competency-units", "POST", createBody), 201, "fixture unit create failed");

    const partial = await assertStatus(
      await request(`/admin/competency-units/${ids.unit}`, "PATCH", { title: "Updated unit", safetyRules: [safety("SAFE-2")] }),
      200, "partial update failed",
    );
    const partialBody = await partial.json() as any;
    assert(partialBody.title === "Updated unit" && partialBody.pathwayIds?.[0] === ids.pathway, "partial PATCH lost pathway mapping");
    assert(partialBody.outcomeMappings?.length === 1 && partialBody.practiceTaskIds?.[0] === ids.task &&
      partialBody.evidenceRequirementIds?.[0] === ids.evidence && partialBody.simulations?.length === 1 &&
      partialBody.safetyRules?.[0]?.code === "SAFE-2", "partial PATCH did not preserve mappings");

    const emptySafety = await assertStatus(
      await request(`/admin/competency-units/${ids.unit}`, "PATCH", { safetyRules: [] }),
      200, "empty safety update failed",
    );
    const emptyBody = await emptySafety.json() as any;
    assert(emptyBody.safetyRules?.length === 0 && emptyBody.pathwayIds?.[0] === ids.pathway &&
      emptyBody.practiceTaskIds?.[0] === ids.task && emptyBody.evidenceRequirementIds?.[0] === ids.evidence &&
      emptyBody.simulations?.length === 1, "empty safetyRules changed non-safety mappings");

    const beforeAuditCount = (await db.select().from(adminAuditEventsTable).where(eq(adminAuditEventsTable.entityId, ids.unit))).length;
    const invalid = await request(`/admin/competency-units/${ids.unit}`, "PATCH", { pathwayIds: [id("missing-pathway")] });
    assert(invalid.status === 409, "invalid FK mapping must be rejected");
    const [unitAfterRollback] = await db.select().from(competencyUnitsTable).where(eq(competencyUnitsTable.id, ids.unit));
    const mappingAfterRollback = await db.select().from(pathwayCompetencyUnitsTable).where(eq(pathwayCompetencyUnitsTable.unitId, ids.unit));
    assert(unitAfterRollback.title === "Updated unit" && mappingAfterRollback.length === 1 && mappingAfterRollback[0].pathwayId === ids.pathway, "failed update was not rolled back");
    const afterAuditCount = (await db.select().from(adminAuditEventsTable).where(eq(adminAuditEventsTable.entityId, ids.unit))).length;
    assert(afterAuditCount === beforeAuditCount, "failed update created an audit event");

    await assertStatus(
      await request(`/admin/competency-units/${ids.unit}`, "PATCH", { title: "Audited unit", safetyRules: [safety("SAFE-3")] }),
      200, "audited update failed",
    );
    const audit = await db.select().from(adminAuditEventsTable)
      .where(and(eq(adminAuditEventsTable.entityId, ids.unit), eq(adminAuditEventsTable.action, "update")))
      .orderBy(desc(adminAuditEventsTable.createdAt));
    const latest = audit.find((event: any) => event.after?.title === "Audited unit") as any;
    assert(latest?.before?.pathwayAssignments && latest.before.outcomeMappings && latest.before.practiceTaskMappings &&
      latest.before.evidenceRequirementMappings && latest.before.simulations && latest.before.safetyRules &&
      latest.after?.pathwayAssignments && latest.after.outcomeMappings && latest.after.practiceTaskMappings &&
      latest.after.evidenceRequirementMappings && latest.after.simulations && latest.after.safetyRules?.[0]?.code === "SAFE-3",
      "audit before/after must include all mappings and changed safety");

    const malformed = await request(`/admin/competency-units/${ids.unit}`, "PATCH", { safetyRules: [{ code: "", rule: "bad", severity: "invalid" }] });
    assert(malformed.status === 400 && !UpdateAdminCompetencyUnitBody.safeParse({ safetyRules: [{ code: "", rule: "bad", severity: "invalid" }] }).success,
      "malformed nested payload must be rejected at HTTP boundary");
    assert(!CreateAdminCompetencyUnitBody.safeParse({ ...createBody, safetyRules: [{ code: "", rule: "", severity: "invalid" }] }).success,
      "malformed create contract must be rejected");

    const rejectSql = async (query: string, values: unknown[], label: string) => {
      let rejected = false;
      try { await pool.query(query, values); } catch { rejected = true; }
      assert(rejected, `${label} was accepted`);
    };
    const otherPath = id("other-path"), otherModule = id("other-module");
    const otherTask = id("other-task"), otherEvidence = id("other-evidence");
    const otherFramework = id("other-framework"), otherUnit = id("other-unit");
    const template = id("template"), source = id("source");
    const element = id("element"), kuk = id("kuk"), foreignElement = id("foreign-element"), foreignKuk = id("foreign-kuk");
    try {
      await pool.query("INSERT INTO teras_pathways (id,program_id,name,type,outcome,status) VALUES ($1,$2,'Other','standard','Other','active')", [otherPath, ids.program]);
      await pool.query("INSERT INTO teras_modules (id,program_id,pathway_id,sequence,code,name,capability,evidence,learning_outcomes,theory) VALUES ($1,$2,$3,2,'M2','Other','Other','Other','{}','{}')", [otherModule, ids.program, otherPath]);
      await pool.query("INSERT INTO teras_practice_tasks (id,module_id,title,description,mode,duration_minutes,output) VALUES ($1,$2,'Other','Other','guided',10,'Other')", [otherTask, otherModule]);
      await pool.query("INSERT INTO teras_evidence_requirements (id,module_id,code,name,description,allowed_types) VALUES ($1,$2,'E2','Other','Other','{text}')", [otherEvidence, otherModule]);
      await pool.query("INSERT INTO teras_competency_frameworks (id,code,name,description,version) VALUES ($1,$2,'Other','Other','2.0')", [otherFramework, id("code")]);
      await pool.query("INSERT INTO teras_competency_units (id,framework_id,code,title,description,sequence) VALUES ($1,$2,'U2','Other','Other',1)", [otherUnit, otherFramework]);
      await pool.query("INSERT INTO teras_competency_elements (id,unit_id,code,title,description) VALUES ($1,$2,'E1','Element','Draft')", [element, ids.unit]);
      await pool.query("INSERT INTO teras_competency_kuks (id,element_id,code,statement) VALUES ($1,$2,'K1','Draft')", [kuk, element]);
      await pool.query("INSERT INTO teras_competency_elements (id,unit_id,code,title,description) VALUES ($1,$2,'E1','Other','Draft')", [foreignElement, otherUnit]);
      await pool.query("INSERT INTO teras_competency_kuks (id,element_id,code,statement) VALUES ($1,$2,'K1','Draft')", [foreignKuk, foreignElement]);
      await rejectSql("INSERT INTO teras_competency_unit_practice_tasks (id,unit_id,task_id) VALUES ($1,$2,$3)", [id("bad-practice"), ids.unit, otherTask], "cross-pathway practice");
      await rejectSql("INSERT INTO teras_competency_unit_evidence_requirements (id,unit_id,requirement_id) VALUES ($1,$2,$3)", [id("bad-evidence"), ids.unit, otherEvidence], "cross-pathway evidence");
      const invalidKuk = await request(`/admin/competency-units/${ids.unit}`, "PATCH", { practiceMappings: [{ taskId: ids.task, kukId: foreignKuk }] });
      assert(invalidKuk.status === 409, "cross-framework KUK practice mapping accepted through API");
      const mapped = await assertStatus(await request(`/admin/competency-units/${ids.unit}`, "PATCH", {
        practiceMappings: [{ taskId: ids.task, kukId: kuk }],
        evidenceMappings: [{ requirementId: ids.evidence, kukId: kuk }],
        outcomeMappings: [{ outcomeCode: "LO-1", description: "Outcome", verificationMethod: "TRAINER_REVIEW", kukId: kuk }],
      }), 200, "KUK traceability update failed");
      const mappedBody = await mapped.json() as any;
      assert(mappedBody.practiceMappings?.[0]?.kukId === kuk && mappedBody.evidenceMappings?.[0]?.kukId === kuk &&
        mappedBody.outcomeMappings?.[0]?.kukId === kuk, "KUK traceability lost at API boundary");
      // Same shape as CompetencyUnitEditor: it always sends legacy ID arrays and
      // pipe-delimited outcome fields, even when only the unit title changes.
      const editorPayload = {
        id: ids.unit, frameworkId: ids.framework, code: mappedBody.code, title: "Editor title change",
        description: mappedBody.description, status: mappedBody.status, sequence: mappedBody.sequence,
        pathwayIds: mappedBody.pathwayIds,
        outcomeMappings: mappedBody.outcomeMappings.map((row: any) => ({
          learningOutcomeId: row.learningOutcomeId ?? null, outcomeCode: row.outcomeCode,
          description: row.description, verificationMethod: row.verificationMethod,
        })),
        practiceTaskIds: mappedBody.practiceTaskIds, evidenceRequirementIds: mappedBody.evidenceRequirementIds,
        simulations: mappedBody.simulations.map((row: any) => ({
          title: row.title, instructions: row.instructions, evidenceRequired: row.evidenceRequired, durationMinutes: row.durationMinutes,
        })),
        safetyRules: mappedBody.safetyRules.map((row: any) => ({
          code: row.code, rule: row.rule, severity: row.severity,
          verificationEvidence: row.verificationEvidence, blocking: row.blocking,
        })),
      };
      const editorSave = await assertStatus(await request(`/admin/competency-units/${ids.unit}`, "PATCH", editorPayload), 200, "editor-shaped update failed");
      const afterEditor = await editorSave.json() as any;
      assert(afterEditor.title === "Editor title change" &&
        afterEditor.outcomeMappings?.[0]?.kukId === kuk &&
        afterEditor.practiceMappings?.[0]?.kukId === kuk &&
        afterEditor.evidenceMappings?.[0]?.kukId === kuk,
        "editor-shaped update silently removed KUK traceability");
      await rejectSql("INSERT INTO teras_diagnostic_templates (id,framework_id,pathway_id,version,name,description,status) VALUES ($1,$2,$3,'v1','Draft','Draft','active')", [template, ids.framework, ids.pathway], "draft diagnostic publication");
      await pool.query("INSERT INTO teras_competency_framework_sources (id,framework_id,regulatory_reference_id,provenance_type) VALUES ($1,$2,'reg-permen-esdm-5-2021','CONTEXT')", [id("context"), ids.framework]);
      await rejectSql("UPDATE teras_competency_frameworks SET authority_status='AUTHORITATIVE' WHERE id=$1", [ids.framework], "context-only authority");
      await pool.query("INSERT INTO teras_competency_framework_sources (id,framework_id,regulatory_reference_id,provenance_type) VALUES ($1,$2,'reg-permen-esdm-6-2021','AUTHORITATIVE')", [source, ids.framework]);
      await pool.query("UPDATE teras_competency_frameworks SET authority_status='AUTHORITATIVE' WHERE id=$1", [ids.framework]);
      await pool.query("INSERT INTO teras_diagnostic_templates (id,framework_id,pathway_id,version,name,description,status) VALUES ($1,$2,$3,'v1','Approved','Approved','active')", [template, ids.framework, ids.pathway]);
      const questionSql = "INSERT INTO teras_diagnostic_questions (id,template_id,framework_id,competency_unit_id,dimension,prompt,sequence) VALUES ($1,$2,$3,$4,'knowledge','Review',1)";
      await rejectSql(questionSql, [id("cross-framework"), template, otherFramework, otherUnit], "cross-framework question");
      await rejectSql(questionSql, [id("cross-pathway"), template, ids.framework, otherUnit], "cross-pathway question");
      await rejectSql("INSERT INTO teras_diagnostic_questions (id,template_id,framework_id,competency_unit_id,kuk_id,dimension,prompt,sequence) VALUES ($1,$2,$3,$4,$5,'knowledge','Wrong KUK',1)",
        [id("bad-kuk-question"), template, ids.framework, ids.unit, foreignKuk], "cross-framework KUK question");
      await pool.query("INSERT INTO teras_diagnostic_questions (id,template_id,framework_id,competency_unit_id,kuk_id,dimension,prompt,sequence) VALUES ($1,$2,$3,$4,$5,'knowledge','Valid',1)",
        [id("valid-question"), template, ids.framework, ids.unit, kuk]);
      await rejectSql("DELETE FROM teras_competency_framework_sources WHERE id=$1", [source], "last authority removal");
      await rejectSql("UPDATE teras_competency_frameworks SET version='3.0' WHERE id=$1", [ids.framework], "framework version change");
      await rejectSql("DELETE FROM teras_pathway_competency_units WHERE unit_id=$1", [ids.unit], "linked pathway removal");
      await rejectSql("UPDATE teras_competency_frameworks SET authority_status='INTERNAL_DRAFT' WHERE id=$1", [ids.framework], "active template authority downgrade");
    } finally {
      await pool.query("DELETE FROM teras_diagnostic_questions WHERE template_id=$1", [template]);
      await pool.query("DELETE FROM teras_diagnostic_templates WHERE id=$1", [template]);
      await pool.query("UPDATE teras_competency_frameworks SET authority_status='INTERNAL_DRAFT' WHERE id=$1", [ids.framework]);
      await pool.query("DELETE FROM teras_competency_framework_sources WHERE framework_id=$1", [ids.framework]);
      await pool.query("UPDATE teras_competency_unit_outcomes SET kuk_id=NULL WHERE unit_id=$1", [ids.unit]);
      await pool.query("UPDATE teras_competency_unit_practice_tasks SET kuk_id=NULL WHERE unit_id=$1", [ids.unit]);
      await pool.query("UPDATE teras_competency_unit_evidence_requirements SET kuk_id=NULL WHERE unit_id=$1", [ids.unit]);
      await pool.query("DELETE FROM teras_competency_kuks WHERE id IN ($1,$2)", [kuk, foreignKuk]);
      await pool.query("DELETE FROM teras_competency_elements WHERE id IN ($1,$2)", [element, foreignElement]);
      await pool.query("DELETE FROM teras_competency_units WHERE id=$1", [otherUnit]);
      await pool.query("DELETE FROM teras_competency_frameworks WHERE id=$1", [otherFramework]);
      await pool.query("DELETE FROM teras_evidence_requirements WHERE id=$1", [otherEvidence]);
      await pool.query("DELETE FROM teras_practice_tasks WHERE id=$1", [otherTask]);
      await pool.query("DELETE FROM teras_modules WHERE id=$1", [otherModule]);
      await pool.query("DELETE FROM teras_pathways WHERE id=$1", [otherPath]);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(adminAuditEventsTable).where(eq(adminAuditEventsTable.entityId, ids.unit));
    await db.delete(competencyUnitSafetyRulesTable).where(eq(competencyUnitSafetyRulesTable.unitId, ids.unit));
    await db.delete(competencyUnitSimulationsTable).where(eq(competencyUnitSimulationsTable.unitId, ids.unit));
    await db.delete(competencyUnitEvidenceRequirementsTable).where(eq(competencyUnitEvidenceRequirementsTable.unitId, ids.unit));
    await db.delete(competencyUnitPracticeTasksTable).where(eq(competencyUnitPracticeTasksTable.unitId, ids.unit));
    await db.delete(competencyUnitOutcomesTable).where(eq(competencyUnitOutcomesTable.unitId, ids.unit));
    await db.delete(pathwayCompetencyUnitsTable).where(eq(pathwayCompetencyUnitsTable.unitId, ids.unit));
    await db.delete(competencyUnitsTable).where(eq(competencyUnitsTable.id, ids.unit));
    await db.delete(competencyFrameworksTable).where(eq(competencyFrameworksTable.id, ids.framework));
    await db.delete(evidenceRequirementsTable).where(eq(evidenceRequirementsTable.id, ids.evidence));
    await db.delete(practiceTasksTable).where(eq(practiceTasksTable.id, ids.task));
    await db.delete(modulesTable).where(eq(modulesTable.id, ids.module));
    await db.delete(pathwaysTable).where(eq(pathwaysTable.id, ids.pathway));
    await db.delete(programsTable).where(eq(programsTable.id, ids.program));
  }
}

await run();
console.log("Competency database integration checks passed");