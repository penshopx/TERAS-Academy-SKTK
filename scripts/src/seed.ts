import { db, programsTable, pathwaysTable, modulesTable, practiceTasksTable, evidenceRequirementsTable, assessmentsTable, assessmentCriteriaTable, enrollmentsTable, evidenceTable, evidenceReviewsTable, assessmentAttemptsTable, criterionObservationsTable, gapsTable, gapEventsTable, remediationPlansTable, remediationActivitiesTable, remediationEventsTable, readinessGatesTable, readinessEventsTable, coursesTable, courseVersionsTable, courseModulesTable, lessonsTable, learningActivitiesTable, contentResourcesTable, learningOutcomesTable, competencyFrameworksTable, competencyUnitsTable, pathwayCompetencyUnitsTable, competencyUnitOutcomesTable, competencyUnitPracticeTasksTable, competencyUnitEvidenceRequirementsTable, competencyUnitSimulationsTable, competencyUnitSafetyRulesTable, diagnosticTemplatesTable, diagnosticQuestionsTable, diagnosticOptionsTable, learningBaselinesTable, baselineModulesTable, pathwayBaselineModulesTable, pathwayModuleContractsTable, legacyModuleMappingsTable } from "@workspace/db";
import { seedManagedPeople } from "@workspace/db/admin-membership";
import { allowsDemoFixtures } from "@workspace/db/demo-access";
import { and, eq } from "drizzle-orm";

const now = new Date("2025-02-14T10:00:00.000Z");
const includeDemoFixtures = process.argv.includes("--demo");
const modules = [
  ["m01","path-a","M01","Fundamentals","PV principles and terminology"], ["m02","path-a","M02","Measurement & Interpretation","Measurement and data interpretation"],
  ["m03","path-a","M03","Safety & Work Practice","Safe PV work practice"], ["m04","path-a","M04","System Architecture","PV system architecture"],
  ["m05","path-a","M05","Drawing & Work Preparation","Drawing and work preparation"], ["m06","path-a","M06","Mechanical Installation","PV mechanical installation"],
  ["m07","path-a","M07","Electrical Installation","PV electrical installation"], ["m08","path-a","M08","System Configuration & Integration","PV system configuration and integration"],
  ["m09","path-a","M09","Testing & Commissioning","PV testing and commissioning"], ["m10","path-a","M10","O&M & Basic Troubleshooting","PV O&M and basic troubleshooting"],
];

const pathBModules = [
  ["b01","path-b","B01","Client brief","Translate client needs into design constraints"],
  ["b02","path-b","B02","Site and yield analysis","Model site conditions and expected yield"],
  ["b03","path-b","B03","System sizing","Select and justify system capacity"],
  ["b04","path-b","B04","Electrical design","Specify protection, cable sizing, and schematics"],
  ["b05","path-b","B05","Structural design","Assure mounting and roof interface design"],
  ["b06","path-b","B06","Performance modelling","Forecast performance and financial return"],
  ["b07","path-b","B07","Design assurance","Review risks, standards, and design decisions"],
  ["b08","path-b","B08","Design pack","Produce a traceable client-ready design pack"],
];
const baselineOutcomes = [
  "Explain PV principles, terminology, and system purpose.",
  "Measure and interpret site and system data to identify relevant PV conditions.",
  "Apply safe work practices, isolation, and risk controls for PV work.",
  "Describe PV system architecture and explain component interfaces.",
  "Produce accurate drawings and work preparation records for PV installation.",
  "Install and secure PV mechanical components in accordance with drawings and manufacturer requirements.",
  "Install PV electrical components, cabling, protection, and terminations safely.",
  "Configure and integrate inverter, monitoring, and system controls.",
  "Test, commission, and document PV system performance and safety.",
  "Perform routine O&M and basic troubleshooting using safe diagnostic steps.",
];
const baselineEvidence = baselineOutcomes.map((_, index) => `E${String(index + 1).padStart(2, "0")}`);
const contractGate = (pathwayId: string, index: number) => pathwayId === "path-a"
  ? index < 3 ? "G1" : index < 7 ? "G2" : "G3"
  : index < 3 ? "B1" : index < 7 ? "B2" : index < 9 ? "B3" : "B4";
const baselineOnly = process.argv.includes("--baseline-only");
async function seed(): Promise<void> {
  if (includeDemoFixtures && !allowsDemoFixtures()) {
    throw new Error("Refusing to seed TERAS demo learner fixtures outside an explicitly enabled safe demo environment");
  }
  if (includeDemoFixtures) {
    await seedManagedPeople([
      { id:"learner-demo", name:"Demo Learner", initials:"DL", email:"learner@teras.academy", role:"Solar PV Technician", organization:"TERAS Academy" },
      { id:"trainer-aria", name:"Aria Trainer", initials:"AT", role:"Trainer", organization:"TERAS Academy" },
      { id:"assessor-sam", name:"Sam Assessor", initials:"SA", role:"Assessor", organization:"TERAS Academy" },
    ]);
  }
  if (baselineOnly) {
    await db.transaction(async tx => {
      const upsert = async (table: any, values: any[]) => {
        for (const value of values) {
          const { id, ...updates } = value;
          await tx.insert(table).values(value).onConflictDoUpdate({ target: table.id, set: updates });
        }
      };
      await tx.insert(programsTable).values({ id: "solar-pv-tech", domain: "Solar PV", track: "Solar PV Installation", name: "Solar PV Installation", description: "Solar PV", status: "Active" }).onConflictDoNothing();
      await tx.insert(pathwaysTable).values([
        { id: "path-a", programId: "solar-pv-tech", name: "Path A", type: "Capability", purpose: "capability-development", outcome: "Capability" },
        { id: "path-b", programId: "solar-pv-tech", name: "Path B", type: "Pre-Certification", purpose: "pre-certification", outcome: "Readiness" },
      ]).onConflictDoNothing();
      await upsert(modulesTable, [...modules, ...pathBModules].map(([id, pathwayId, code, name, capability], index) => ({
        id, programId: "solar-pv-tech", pathwayId, sequence: index + 1, code, name, capability,
        evidence: "E00", learningOutcomes: ["Seeded module"], theory: ["Seeded module"],
      })));
      await upsert(learningBaselinesTable, [{ id: "baseline-solar-pv-v1", code: "SOLAR-PV-BASELINE", name: "Solar PV Learning Baseline", description: "Shared M01-M10 Solar PV learning baseline.", version: "1.0", status: "active" }]);
      await upsert(baselineModulesTable, modules.map(([moduleId, , code, name], index) => ({
        id: `baseline-module-${moduleId}`, baselineId: "baseline-solar-pv-v1", moduleId, sequence: index + 1,
        code, name, learningOutcome: baselineOutcomes[index], evidenceId: baselineEvidence[index], status: "active",
      })));
      await upsert(pathwayBaselineModulesTable, ["path-a", "path-b"].flatMap(pathwayId => modules.map(([moduleId, , code], index) => ({
        id: `pathway-${pathwayId}-baseline-${code}`, pathwayId, baselineModuleId: `baseline-module-${moduleId}`, sequence: index + 1, required: true, status: "active",
      }))));
      await upsert(pathwayModuleContractsTable, ["path-a", "path-b"].flatMap(pathwayId => modules.map(([moduleId, , code], index) => ({
        id: `contract-${pathwayId}-${code}`, pathwayId, moduleId, assessmentId: `assessment-${moduleId}`, evidenceRequirementId: `req-${moduleId}`, gateCode: contractGate(pathwayId, index), assessment: pathwayId === "path-a" ? "Observed capability assessment" : "Pre-certification readiness assessment",
        evidence: `${baselineEvidence[index]} — baseline evidence requirement`, output: pathwayId === "path-a" ? "Capability Portfolio entry" : "Certification Readiness Portfolio entry",
        kpi: pathwayId === "path-a" ? "capability achievement" : "readiness", portfolio: pathwayId === "path-a" ? "Capability Portfolio" : "Certification Readiness Portfolio",
      }))));
      const legacyMappings = Object.entries({ b01: "m05", b02: "m02", b03: "m04", b04: "m07", b05: "m06", b06: "m08", b07: "m09", b08: "m10" }).map(([legacyModuleId, moduleId]) => ({
        id: `legacy-map-${legacyModuleId}`, legacyModuleId, baselineModuleId: `baseline-module-${moduleId}`, pathwayId: "path-b", status: "retired",
        note: "Legacy Path B catalogue record retained for historical learner references.",
      }));
      for (const mapping of legacyMappings) {
        await tx.insert(legacyModuleMappingsTable).values(mapping).onConflictDoUpdate({
          target: legacyModuleMappingsTable.legacyModuleId,
          set: { baselineModuleId: mapping.baselineModuleId, pathwayId: mapping.pathwayId, status: mapping.status, note: mapping.note },
        });
      }
    });
    return;
  }
  await db.transaction(async tx => {
  const insert = async (table: any, values: any[]) => tx.insert(table).values(values).onConflictDoNothing();
  const upsert = async (table: any, values: any[]) => {
    for (const value of values) {
      const { id, ...updates } = value;
      await tx.insert(table).values(value).onConflictDoUpdate({ target: table.id, set: { ...updates, ...(table.updatedAt ? { updatedAt: now } : {}) } });
    }
  };
  await insert(programsTable, [{ id:"solar-pv-tech", domain:"Solar PV", track:"Solar PV Installation", name:"Solar PV Installation", description:"Capability development and pre-certification preparation for safe Solar PV installation.", status:"Active" }]);
  await insert(pathwaysTable, [
    {id:"path-a",programId:"solar-pv-tech",name:"Path A — Capability Development",type:"Capability",purpose:"capability-development",outcome:"Capability Achievement supported by a traceable Capability Portfolio"},
    {id:"path-b",programId:"solar-pv-tech",name:"Path B — Pre-Certification",type:"Pre-Certification",purpose:"pre-certification",outcome:"Certification Readiness supported by a traceable Readiness Portfolio"},
  ]);
  await tx.update(programsTable).set({domain:"Solar PV",track:"Solar PV Installation",name:"Solar PV Installation",description:"Capability development and pre-certification preparation for safe Solar PV installation."}).where(eq(programsTable.id,"solar-pv-tech"));
  await tx.update(pathwaysTable).set({name:"Path A — Capability Development",type:"Capability",purpose:"capability-development",outcome:"Capability Achievement supported by a traceable Capability Portfolio"}).where(eq(pathwaysTable.id,"path-a"));
  await tx.update(pathwaysTable).set({name:"Path B — Pre-Certification",type:"Pre-Certification",purpose:"pre-certification",outcome:"Certification Readiness supported by a traceable Readiness Portfolio"}).where(eq(pathwaysTable.id,"path-b"));
  await upsert(modulesTable, [...modules, ...pathBModules].map(([id, pathwayId, code, name, capability], i) => {
    const baselineIndex = modules.findIndex((module) => module[0] === id);
    return {
      id, programId:"solar-pv-tech", pathwayId, sequence:i < modules.length ? i+1 : i - modules.length + 1, code, name, capability,
      evidence: baselineIndex >= 0 ? baselineEvidence[baselineIndex] : `${code} practical evidence`,
      learningOutcomes: baselineIndex >= 0 ? [baselineOutcomes[baselineIndex]] : [`Apply ${name.toLowerCase()} procedures`],
      theory:[`${name} guide`],
    };
  }));
  await upsert(learningBaselinesTable, [{
    id:"baseline-solar-pv-v1", code:"SOLAR-PV-BASELINE", name:"Solar PV Learning Baseline",
    description:"Shared M01-M10 Solar PV learning baseline used by Path A and Path B.", version:"1.0", status:"active",
  }]);
  await upsert(baselineModulesTable, modules.map(([moduleId], index) => ({
    id:`baseline-module-${moduleId}`, baselineId:"baseline-solar-pv-v1", moduleId, sequence:index + 1,
    code:`M${String(index + 1).padStart(2, "0")}`, name:modules[index][3], learningOutcome:baselineOutcomes[index],
    evidenceId:baselineEvidence[index], status:"active",
  })));
  await upsert(pathwayBaselineModulesTable, ["path-a", "path-b"].flatMap((pathwayId) => modules.map(([moduleId], index) => ({
    id:`pathway-${pathwayId}-baseline-M${String(index + 1).padStart(2, "0")}`, pathwayId,
    baselineModuleId:`baseline-module-${moduleId}`, sequence:index + 1, required:true, status:"active",
  }))));
  await upsert(pathwayModuleContractsTable, ["path-a", "path-b"].flatMap((pathwayId) => modules.map(([moduleId], index) => ({
    id:`contract-${pathwayId}-M${String(index + 1).padStart(2, "0")}`, pathwayId, moduleId,
    assessmentId:`assessment-${moduleId}`, evidenceRequirementId:`req-${moduleId}`, gateCode:contractGate(pathwayId, index),
    assessment:pathwayId === "path-a" ? "Observed capability assessment" : "Pre-certification readiness assessment",
    evidence:`${baselineEvidence[index]} — baseline evidence requirement`,
    output:pathwayId === "path-a" ? "Capability Portfolio entry" : "Certification Readiness Portfolio entry",
    kpi:pathwayId === "path-a" ? "capability achievement" : "readiness",
    portfolio:pathwayId === "path-a" ? "Capability Portfolio" : "Certification Readiness Portfolio",
  }))));
  const legacyMappings: Record<string, string> = { b01:"m05", b02:"m02", b03:"m04", b04:"m07", b05:"m06", b06:"m08", b07:"m09", b08:"m10" };
  for (const mapping of Object.entries(legacyMappings).map(([legacyModuleId, moduleId]) => ({
    id:`legacy-map-${legacyModuleId}`, legacyModuleId, baselineModuleId:`baseline-module-${moduleId}`,
    pathwayId:"path-b", status:"retired", note:"Legacy Path B catalogue record retained for historical learner references.",
  }))) {
    await tx.insert(legacyModuleMappingsTable).values(mapping).onConflictDoUpdate({
      target: legacyModuleMappingsTable.legacyModuleId,
      set: { baselineModuleId: mapping.baselineModuleId, pathwayId: mapping.pathwayId, status: mapping.status, note: mapping.note, updatedAt: now },
    });
  }
  await insert(coursesTable, [
    {id:"course-solar-installation",programId:"solar-pv-tech",pathwayId:"path-a",code:"SPV-INSTALL",title:"Solar PV Installation Learning Core",description:"Learning preparation linked to the existing installation capability pathway.",status:"PUBLISHED",sequence:1},
    {id:"course-solar-design",programId:"solar-pv-tech",pathwayId:"path-b",code:"SPV-DESIGN",title:"Solar PV Design Learning Core",description:"Learning preparation linked to the existing design capability pathway.",status:"PUBLISHED",sequence:1},
  ]);
  await insert(courseModulesTable, [
    {id:"course-module-m03",courseId:"course-solar-installation",moduleId:"m03",programId:"solar-pv-tech",pathwayId:"path-a",sequence:1},
    {id:"course-module-b04",courseId:"course-solar-design",moduleId:"b04",programId:"solar-pv-tech",pathwayId:"path-b",sequence:1},
  ]);
  await insert(lessonsTable, [
    {id:"lesson-m03-isolation",courseModuleId:"course-module-m03",programId:"solar-pv-tech",pathwayId:"path-a",title:"Safe isolation foundations",description:"Prepare for supervised safe isolation practice.",sequence:1,status:"PUBLISHED",estimatedDurationMinutes:25},
    {id:"lesson-b04-protection",courseModuleId:"course-module-b04",programId:"solar-pv-tech",pathwayId:"path-b",title:"Electrical protection design",description:"Prepare a defensible protection design before practice.",sequence:1,status:"PUBLISHED",estimatedDurationMinutes:30},
  ]);
  await insert(learningActivitiesTable, [
    {id:"activity-m03-safe-isolation",lessonId:"lesson-m03-isolation",programId:"solar-pv-tech",pathwayId:"path-a",type:"READING",title:"Safe isolation sequence",description:"Study the safe isolation and proving sequence before supervised practice.",sequence:1,required:true,estimatedDurationMinutes:15,status:"PUBLISHED"},
    {id:"activity-b04-protection",lessonId:"lesson-b04-protection",programId:"solar-pv-tech",pathwayId:"path-b",type:"ASSIGNMENT",title:"Protection selection rationale",description:"Prepare the design rationale for protection selection.",sequence:1,required:true,estimatedDurationMinutes:20,status:"PUBLISHED"},
  ]);
  await insert(contentResourcesTable, [
    {id:"resource-m03-isolation",activityId:"activity-m03-safe-isolation",type:"TEXT",title:"Safe isolation learning note",content:"Learning guidance only. Performance must still be practiced, evidenced, reviewed, and reassessed.",sequence:1},
    {id:"resource-b04-protection",activityId:"activity-b04-protection",type:"TEXT",title:"Protection design learning note",content:"Learning guidance only. Design capability still requires traceable practice and evidence.",sequence:1},
  ]);
  await insert(courseModulesTable, [{id:"course-module-m07",courseId:"course-solar-installation",moduleId:"m07",programId:"solar-pv-tech",pathwayId:"path-a",sequence:2}]);
  await insert(lessonsTable, [{id:"lesson-m07-commissioning",courseModuleId:"course-module-m07",programId:"solar-pv-tech",pathwayId:"path-a",title:"Commissioning preparation",description:"Prepare for supervised commissioning practice.",sequence:1,status:"PUBLISHED",estimatedDurationMinutes:25}]);
  await insert(learningActivitiesTable, [{id:"activity-m07-commissioning",lessonId:"lesson-m07-commissioning",programId:"solar-pv-tech",pathwayId:"path-a",type:"READING",title:"Commissioning test sequence",description:"Study the commissioning sequence before supervised practice.",sequence:1,required:true,estimatedDurationMinutes:20,status:"PUBLISHED"}]);
  await insert(learningOutcomesTable, [
    {id:"outcome-m03-sequence",activityId:"activity-m03-safe-isolation",capabilityModuleId:"m03",description:"Explain the safe isolation and proving sequence.",verificationMethod:"TRAINER_REVIEW",required:true},
    {id:"outcome-b04-protection",activityId:"activity-b04-protection",capabilityModuleId:"b04",description:"Explain and justify protection selection.",verificationMethod:"TRAINER_REVIEW",required:true},
    {id:"outcome-m07-commissioning",activityId:"activity-m07-commissioning",capabilityModuleId:"m07",description:"Apply the inverter commissioning sequence and record test results.",verificationMethod:"TRAINER_REVIEW",required:true},
  ]);
  // Every shared M01-M10 baseline record is represented in the complete LMS
  // course -> module -> lesson -> activity -> outcome hierarchy for both
  // pathways. Existing M03/M07 IDs are deliberately retained.
  await upsert(courseModulesTable, [
    {id:"course-module-m03",courseId:"course-solar-installation",moduleId:"m03",programId:"solar-pv-tech",pathwayId:"path-a",sequence:3,status:"PUBLISHED"},
    {id:"course-module-m07",courseId:"course-solar-installation",moduleId:"m07",programId:"solar-pv-tech",pathwayId:"path-a",sequence:7,status:"PUBLISHED"},
    {id:"course-module-b04",courseId:"course-solar-design",moduleId:"b04",programId:"solar-pv-tech",pathwayId:"path-b",sequence:11,status:"PUBLISHED"},
  ]);
  // The common M01-M10 learning hierarchy has one owner. Path B reaches the
  // same rows through pathwayBaselineModulesTable; its legacy B04 hierarchy
  // remains separately addressable below.
  for (const pathwayId of ["path-a"]) {
    const courseId = pathwayId === "path-a" ? "course-solar-installation" : "course-solar-design";
    for (let index = 0; index < modules.length; index += 1) {
      const moduleId = modules[index][0];
      const moduleCode = modules[index][2];
      const courseModuleId = pathwayId === "path-a" && moduleId === "m03"
        ? "course-module-m03"
        : pathwayId === "path-a" && moduleId === "m07"
          ? "course-module-m07"
          : `course-module-${moduleId}`;
      const lessonId = pathwayId === "path-a" && moduleId === "m03"
        ? "lesson-m03-isolation"
        : pathwayId === "path-a" && moduleId === "m07"
          ? "lesson-m07-commissioning"
          : `lesson-${moduleId}`;
      const activityId = pathwayId === "path-a" && moduleId === "m03"
        ? "activity-m03-safe-isolation"
        : pathwayId === "path-a" && moduleId === "m07"
          ? "activity-m07-commissioning"
          : `activity-${moduleId}`;
      await upsert(courseModulesTable, [{
        id:courseModuleId, courseId, moduleId, programId:"solar-pv-tech", pathwayId, sequence:index + 1, status:"PUBLISHED",
      }]);
      await upsert(lessonsTable, [{
        id:lessonId, courseModuleId, programId:"solar-pv-tech", pathwayId,
        title:`${moduleCode} ${modules[index][3]}`, description:`Learn ${modules[index][3]} in the shared Solar PV baseline.`,
        sequence:1, status:"PUBLISHED", estimatedDurationMinutes:25,
      }]);
      await upsert(learningActivitiesTable, [{
        id:activityId, lessonId, programId:"solar-pv-tech", pathwayId, type:"READING",
        title:`${moduleCode} controlled learning`, description:baselineOutcomes[index],
        sequence:1, required:true, estimatedDurationMinutes:20, status:"PUBLISHED",
      }]);
      await upsert(contentResourcesTable, [{
        id:moduleId === "m03" ? "resource-m03-isolation" : `resource-${moduleId}`, activityId, type:"TEXT",
        title:`${moduleCode} learning note`, content:`${baselineOutcomes[index]} Learning guidance only; performance must be practiced and evidenced.`,
        sequence:1, status:"PUBLISHED",
      }]);
      await upsert(learningOutcomesTable, [{
        id:moduleId === "m03" ? "outcome-m03-sequence" : moduleId === "m07" ? "outcome-m07-commissioning" : `outcome-${moduleId}`,
        activityId, capabilityModuleId:moduleId,
        description:baselineOutcomes[index], verificationMethod:"TRAINER_REVIEW", required:true, sequence:1, status:"PUBLISHED",
      }]);
    }
  }
  // Publish the shared Path A course aggregate so both pathways can consume
  // the immutable learner projection. Path B resolves these rows through its
  // baseline selections and never receives a duplicate course hierarchy.
  for (const course of await tx.select().from(coursesTable).where(eq(coursesTable.pathwayId, "path-a"))) {
    const links = await tx.select().from(courseModulesTable).where(eq(courseModulesTable.courseId, course.id));
    const lessons = await tx.select().from(lessonsTable);
    const activities = await tx.select().from(learningActivitiesTable);
    const resources = await tx.select().from(contentResourcesTable);
    const outcomes = await tx.select().from(learningOutcomesTable);
    const moduleSnapshot = links.sort((a, b) => a.sequence - b.sequence).map((link) => ({
      ...link,
      moduleCode: modules.find((module) => module[0] === link.moduleId)?.[2] ?? "UNKNOWN",
      moduleName: modules.find((module) => module[0] === link.moduleId)?.[3] ?? "Unknown module",
      lessons: lessons.filter((lesson) => lesson.courseModuleId === link.id).map((lesson) => ({
        ...lesson,
        moduleId: link.moduleId,
        activities: activities.filter((activity) => activity.lessonId === lesson.id).map((activity) => ({
          ...activity,
          currentState: "NOT_STARTED",
          nextAction: { action: "START_ACTIVITY", title: "Start activity", description: "Begin this learning activity.", href: null },
          resources: resources.filter((resource) => resource.activityId === activity.id),
          outcomes: outcomes.filter((outcome) => outcome.activityId === activity.id),
        })),
      })),
    }));
    const [existingVersion] = await tx.select().from(courseVersionsTable).where(and(
      eq(courseVersionsTable.courseId, course.id),
      eq(courseVersionsTable.version, 1),
    ));
    const versionId = existingVersion?.id ?? `course-version-${course.id}-v1`;
    const version = {
      id: versionId, courseId: course.id, version: 1, lifecycle: "PUBLISHED",
      snapshot: { ...course, modules: moduleSnapshot, authoringRevision: 0 },
      validationReport: { valid: true, errors: [], warnings: [] }, publishedAt: now, publishedBy: "system-seed",
    };
    if (existingVersion) {
      await tx.update(courseVersionsTable).set({ lifecycle: version.lifecycle, snapshot: version.snapshot, validationReport: version.validationReport, publishedAt: now, publishedBy: version.publishedBy }).where(eq(courseVersionsTable.id, versionId));
    } else {
      await tx.insert(courseVersionsTable).values(version);
    }
    await tx.update(coursesTable).set({ status: "PUBLISHED", publishedVersionId: versionId }).where(eq(coursesTable.id, course.id));
  }
  // These catalogue rows are prerequisites for the traceability foreign keys.
  // The later idempotent inserts retain the historical seed ordering.
  await insert(practiceTasksTable, [...modules, ...pathBModules].map(([id, pathwayId, code, name], i) => ({id:`task-${id}`,moduleId:id,title:`${name} ${pathwayId === "path-b" ? "design exercise" : "practical"}`,description:`Complete the ${name.toLowerCase()} supervised exercise.`,mode:i===2 || pathwayId === "path-b" ? "Workshop":"Guided practice",durationMinutes:pathwayId === "path-b" ? 60 : 45,output:pathwayId === "path-b" ? "Traceable design work record":"Supervisor-ready work record",safetyNote:id==="m03"?"Safe isolation procedure is mandatory.":null})));
  await insert(evidenceRequirementsTable, [...modules, ...pathBModules].map(([id, pathwayId, code, name]) => ({id:`req-${id}`,moduleId:id,code:`EV-${code}`,name:`${name} evidence`,description:`Traceable evidence for ${name}.`,allowedTypes:pathwayId === "path-b" ? ["Design brief","Calculation","Drawing","Report"] : ["Photo","Checklist","Report"]})));
  await upsert(evidenceRequirementsTable, modules.map(([id], index) => ({
    id:`req-${id}`, moduleId:id, code:baselineEvidence[index], name:`${baselineEvidence[index]} — ${modules[index][3]} evidence`,
    description:`Traceable evidence demonstrating the controlled outcome: ${baselineOutcomes[index]}`,
    allowedTypes:["Photo","Checklist","Report"],
  })));
  // Reusable SKTTK framework: these IDs deliberately point at the existing
  // Solar PV catalogue records so the configuration remains idempotent and
  // traceable after repeated seed runs.
  await insert(competencyFrameworksTable, [{ id:"framework-skttk-solar-pv", code:"SKTTK-SPV", name:"SKTTK Solar PV", description:"Internal draft framework for readiness operations; not an official competency framework.", domain:"renewable-energy", version:"1.0", status:"active", authorityStatus:"INTERNAL_DRAFT" }]);
  const competencyUnits = [
    { id:"skttk-u-safe-isolation", frameworkId:"framework-skttk-solar-pv", code:"SKTTK-SPV-01", title:"Keselamatan dan isolasi listrik", description:"Menerapkan isolasi aman, pembuktian bebas tegangan, dan kontrol risiko.", sequence:1, status:"active" },
    { id:"skttk-u-installation", frameworkId:"framework-skttk-solar-pv", code:"SKTTK-SPV-02", title:"Instalasi dan commissioning PV", description:"Menyiapkan instalasi, pengujian, dan commissioning sistem PV.", sequence:2, status:"active" },
    { id:"skttk-u-design", frameworkId:"framework-skttk-solar-pv", code:"SKTTK-SPV-03", title:"Perancangan sistem PV", description:"Menghasilkan desain PV yang dapat ditelusuri dari brief hingga pack.", sequence:3, status:"active" },
  ];
  await insert(competencyUnitsTable, competencyUnits);
  await insert(pathwayCompetencyUnitsTable, [
    { id:"skttk-map-path-a-safe", pathwayId:"path-a", unitId:"skttk-u-safe-isolation", sequence:1 },
    { id:"skttk-map-path-a-install", pathwayId:"path-a", unitId:"skttk-u-installation", sequence:2 },
    { id:"skttk-map-path-b-design", pathwayId:"path-b", unitId:"skttk-u-design", sequence:1 },
  ]);
  await insert(competencyUnitOutcomesTable, [
    { id:"skttk-outcome-safe", unitId:"skttk-u-safe-isolation", learningOutcomeId:"outcome-m03-sequence", outcomeCode:"LO-SPV-01", description:"Explain the safe isolation and proving sequence.", verificationMethod:"TRAINER_REVIEW" },
    { id:"skttk-outcome-install", unitId:"skttk-u-installation", learningOutcomeId:"outcome-m07-commissioning", outcomeCode:"LO-SPV-02", description:"Apply inverter commissioning procedures and record test results.", verificationMethod:"TRAINER_REVIEW" },
    { id:"skttk-outcome-design", unitId:"skttk-u-design", learningOutcomeId:"outcome-b04-protection", outcomeCode:"LO-SPV-03", description:"Explain and justify protection selection.", verificationMethod:"TRAINER_REVIEW" },
  ]);
  await insert(competencyUnitPracticeTasksTable, [
    { id:"skttk-task-safe", unitId:"skttk-u-safe-isolation", taskId:"task-m03" },
    { id:"skttk-task-install", unitId:"skttk-u-installation", taskId:"task-m07" },
    { id:"skttk-task-design", unitId:"skttk-u-design", taskId:"task-b04" },
  ]);
  await insert(competencyUnitEvidenceRequirementsTable, [
    { id:"skttk-evidence-safe", unitId:"skttk-u-safe-isolation", requirementId:"req-m03" },
    { id:"skttk-evidence-install", unitId:"skttk-u-installation", requirementId:"req-m07" },
    { id:"skttk-evidence-design", unitId:"skttk-u-design", requirementId:"req-b04" },
  ]);
  await insert(competencyUnitSimulationsTable, [
    { id:"skttk-sim-safe", unitId:"skttk-u-safe-isolation", title:"Simulasi internal isolasi aman", instructions:"Latihan terbimbing pembuktian bebas tegangan sebelum praktik.", evidenceRequired:"Checklist latihan dan umpan balik trainer", durationMinutes:30 },
    { id:"skttk-sim-install", unitId:"skttk-u-installation", title:"Simulasi internal commissioning", instructions:"Latihan membaca hasil uji dan menyusun catatan commissioning.", evidenceRequired:"Catatan hasil uji latihan", durationMinutes:45 },
    { id:"skttk-sim-design", unitId:"skttk-u-design", title:"Persiapan internal desain proteksi", instructions:"Latihan menyusun alasan pemilihan proteksi pada skenario desain.", evidenceRequired:"Rationale desain latihan", durationMinutes:40 },
  ]);
  await insert(competencyUnitSafetyRulesTable, [
    { id:"skttk-safety-safe-isolation", unitId:"skttk-u-safe-isolation", code:"SAFE-01", rule:"Isolasi sumber dan prove-dead wajib sebelum menyentuh konduktor.", severity:"critical", verificationEvidence:"Checklist isolasi ditinjau trainer", blocking:true },
    { id:"skttk-safety-installation", unitId:"skttk-u-installation", code:"SAFE-02", rule:"Gunakan APD dan prosedur kerja aman selama instalasi serta commissioning.", severity:"critical", verificationEvidence:"Observasi trainer dan catatan toolbox talk", blocking:true },
    { id:"skttk-safety-design", unitId:"skttk-u-design", code:"SAFE-03", rule:"Desain harus mengidentifikasi risiko listrik, struktur, dan akses pemeliharaan.", severity:"high", verificationEvidence:"Review risiko pada design pack", blocking:true },
  ]);
  await insert(diagnosticTemplatesTable, [{ id:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", pathwayId:"path-a", version:"1.0", name:"SKTTK Solar PV Personal Diagnostic", description:"Internal synthetic self-diagnostic; not official SKTTK content or a competence decision.", status:"draft", dimensions:["Safety","Knowledge","Practice","Evidence","Problem solving","Readiness"] }]);
  await insert(diagnosticQuestionsTable, [
    { id:"diag-q-safety", templateId:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", competencyUnitId:"skttk-u-safe-isolation", dimension:"Safety", prompt:"Before touching a PV conductor, what do you do?", sequence:1 },
    { id:"diag-q-knowledge", templateId:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", competencyUnitId:"skttk-u-installation", dimension:"Knowledge", prompt:"How confident are you explaining the commissioning sequence?", sequence:2 },
    { id:"diag-q-practice", templateId:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", competencyUnitId:"skttk-u-installation", dimension:"Practice", prompt:"How much supervised PV practice have you completed?", sequence:3 },
    { id:"diag-q-evidence", templateId:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", competencyUnitId:"skttk-u-installation", dimension:"Evidence", prompt:"How much traceable evidence can you show?", sequence:4 },
    { id:"diag-q-problem", templateId:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", competencyUnitId:"skttk-u-installation", dimension:"Problem solving", prompt:"How do you approach an unexpected commissioning result?", sequence:5 },
    { id:"diag-q-readiness", templateId:"diag-skttk-spv-v1", frameworkId:"framework-skttk-solar-pv", competencyUnitId:"skttk-u-safe-isolation", dimension:"Readiness", prompt:"What support would help you take your next supervised step?", sequence:6 },
  ]);
  await insert(diagnosticOptionsTable, [
    { id:"diag-o-safe", questionId:"diag-q-safety", code:"CRITICAL_FAILURE", label:"I would work live without isolation.", score:0, safetyOutcome:"CRITICAL_SAFETY_FAILURE" },
    { id:"diag-o-safe-ok", questionId:"diag-q-safety", code:"SAFE_SEQUENCE", label:"Isolate, lock out, prove dead, then work.", score:3, safetyOutcome:"SAFE" },
    ...["diag-q-knowledge","diag-q-practice","diag-q-evidence","diag-q-problem","diag-q-readiness"].flatMap((questionId, qi) => [
      { id:`${questionId}-low`, questionId, code:"LOW", label:"I need substantial guidance.", score:0 },
      { id:`${questionId}-developing`, questionId, code:"DEVELOPING", label:"I can do parts with support.", score:2 },
      { id:`${questionId}-strong`, questionId, code:"STRONG", label:"I can explain and demonstrate this consistently.", score:3 },
    ]),
  ]);
  await insert(practiceTasksTable, [...modules, ...pathBModules].map(([id, pathwayId, code, name], i) => ({id:`task-${id}`,moduleId:id,title:`${name} ${pathwayId === "path-b" ? "design exercise" : "practical"}`,description:`Complete the ${name.toLowerCase()} supervised exercise.`,mode:i===2 || pathwayId === "path-b" ? "Workshop":"Guided practice",durationMinutes:pathwayId === "path-b" ? 60 : 45,output:pathwayId === "path-b" ? "Traceable design work record":"Supervisor-ready work record",safetyNote:id==="m03"?"Safe isolation procedure is mandatory.":null})));
  await insert(evidenceRequirementsTable, [...modules, ...pathBModules].map(([id, pathwayId, code, name]) => ({id:`req-${id}`,moduleId:id,code:`EV-${code}`,name:`${name} evidence`,description:`Traceable evidence for ${name}.`,allowedTypes:pathwayId === "path-b" ? ["Design brief","Calculation","Drawing","Report"] : ["Photo","Checklist","Report"]})));
  const assessmentGates: Record<string, string> = {m03:"G1",m07:"G2",b01:"B1",b02:"B2",b03:"B2",b04:"B2",b05:"B2",b06:"B2",b07:"B3",b08:"B4"};
  await insert(assessmentsTable, [...modules, ...pathBModules].map(([id, pathwayId, code]) => ({id:`assessment-${id}`,moduleId:id,name:`${code} ${pathwayId === "path-b" ? "design assessment" : "practical assessment"}`,gateCode:assessmentGates[id]})));
  for (const [moduleId, gateCode] of Object.entries(assessmentGates)) {
    await tx.update(assessmentsTable).set({ gateCode }).where(eq(assessmentsTable.id, `assessment-${moduleId}`));
  }
  await insert(assessmentCriteriaTable, [
    ...modules
      .filter(([moduleId]) => moduleId !== "m03" && moduleId !== "m07")
      .map(([moduleId, , code, name]) => ({
        id: `crit-${moduleId}-baseline`,
        assessmentId: `assessment-${moduleId}`,
        code: `BASE-${code}`,
        label: `Demonstrates ${name} baseline outcome`,
        layer: "Technical",
        critical: false,
      })),
    {id:"crit-m03-isolation",assessmentId:"assessment-m03",code:"SAFE-01",label:"Proves safe isolation",layer:"Safety",critical:true},
    {id:"crit-m03-test",assessmentId:"assessment-m03",code:"SAFE-02",label:"Selects and proves test equipment",layer:"Safety",critical:true},
    {id:"crit-m07-commission",assessmentId:"assessment-m07",code:"TECH-01",label:"Completes commissioning sequence",layer:"Technical",critical:false},
    {id:"crit-m07-results",assessmentId:"assessment-m07",code:"TECH-02",label:"Records test results",layer:"Evidence",critical:false},
    {id:"crit-b02-yield",assessmentId:"assessment-b02",code:"DES-01",label:"Builds a traceable yield model",layer:"Technical",critical:false},
    {id:"crit-b02-assumptions",assessmentId:"assessment-b02",code:"DES-02",label:"Explains design assumptions",layer:"Evidence",critical:false},
    {id:"crit-b01-brief",assessmentId:"assessment-b01",code:"DES-BRIEF-01",label:"Captures client needs and constraints",layer:"Evidence",critical:false},
    {id:"crit-b01-scope",assessmentId:"assessment-b01",code:"DES-BRIEF-02",label:"Defines a viable design scope",layer:"Technical",critical:false},
    {id:"crit-b03-sizing",assessmentId:"assessment-b03",code:"DES-SIZE-01",label:"Justifies system capacity",layer:"Technical",critical:false},
    {id:"crit-b03-components",assessmentId:"assessment-b03",code:"DES-SIZE-02",label:"Selects compatible components",layer:"Technical",critical:false},
    {id:"crit-b04-protection",assessmentId:"assessment-b04",code:"DES-03",label:"Specifies appropriate electrical protection",layer:"Safety",critical:true},
    {id:"crit-b04-schematic",assessmentId:"assessment-b04",code:"DES-04",label:"Produces a coherent electrical schematic",layer:"Technical",critical:false},
    {id:"crit-b05-loads",assessmentId:"assessment-b05",code:"DES-STRUCT-01",label:"Checks structural loads and interfaces",layer:"Safety",critical:false},
    {id:"crit-b05-detail",assessmentId:"assessment-b05",code:"DES-STRUCT-02",label:"Documents mounting details",layer:"Evidence",critical:false},
    {id:"crit-b06-model",assessmentId:"assessment-b06",code:"DES-PERF-01",label:"Builds a defensible performance model",layer:"Technical",critical:false},
    {id:"crit-b06-return",assessmentId:"assessment-b06",code:"DES-PERF-02",label:"Explains forecast return and sensitivity",layer:"Evidence",critical:false},
    {id:"crit-b07-review",assessmentId:"assessment-b07",code:"DES-05",label:"Identifies and resolves design risks",layer:"Assurance",critical:true},
    {id:"crit-b07-standards",assessmentId:"assessment-b07",code:"DES-06",label:"References applicable standards",layer:"Assurance",critical:false},
    {id:"crit-b08-pack",assessmentId:"assessment-b08",code:"DES-PACK-01",label:"Produces a complete design pack",layer:"Evidence",critical:false},
    {id:"crit-b08-trace",assessmentId:"assessment-b08",code:"DES-PACK-02",label:"Maintains traceability from brief to handover",layer:"Assurance",critical:false},
  ]);
  if (includeDemoFixtures) {
  await insert(enrollmentsTable, [{id:"enrol-demo",learnerId:"learner-demo",programId:"solar-pv-tech",pathwayId:"path-a",trainerId:"trainer-aria",assessorId:"assessor-sam"}]);
  await insert(evidenceTable, [
    {id:"evidence-m03",learnerId:"learner-demo",pathwayId:"path-a",moduleId:"m03",taskId:"task-m03",title:"Safe isolation checklist",type:"Checklist",description:"Recorded safe isolation and proving sequence.",fileName:"m03-safe-isolation.pdf",createdAt:now},
    {id:"evidence-m07",learnerId:"learner-demo",pathwayId:"path-a",moduleId:"m07",taskId:"task-m07",title:"Commissioning test record",type:"Report",description:"Inverter commissioning values and checks.",fileName:"m07-commissioning.pdf",createdAt:now},
  ]);
  await insert(evidenceReviewsTable, [
    {id:"review-m03",evidenceId:"evidence-m03",reviewerId:"trainer-aria",status:"Valid",comment:"Clear traceable safety record.",quality:{valid:true,relevant:true,sufficient:true,traceable:true},createdAt:now},
    {id:"review-m07",evidenceId:"evidence-m07",reviewerId:"assessor-sam",status:"Under review",comment:null,quality:{valid:false,relevant:true,sufficient:false,traceable:true},createdAt:now},
  ]);
  await insert(assessmentAttemptsTable, [{id:"attempt-m03-1",assessmentId:"assessment-m03",learnerId:"learner-demo",pathwayId:"path-a",number:1,assessorId:"assessor-sam",status:"Completed",decision:"Competent",createdAt:now}]);
  await insert(criterionObservationsTable, [
    {id:"obs-m03-1",attemptId:"attempt-m03-1",criterionId:"crit-m03-isolation",score:3,observation:"Sequence completed without prompting.",evidenceId:"evidence-m03"},
    {id:"obs-m03-2",attemptId:"attempt-m03-1",criterionId:"crit-m03-test",score:3,observation:"Tester proven before and after use.",evidenceId:"evidence-m03"},
  ]);
  await insert(gapsTable, [{id:"gap-m07",learnerId:"learner-demo",pathwayId:"path-a",moduleId:"m07",capability:"Inverter commissioning",criterion:"TECH-02",severity:"Moderate",priority:"High",diagnosis:"Test record requires assessor confirmation.",gate:"G2",recommendedAction:"Complete guided commissioning review."}]);
  await insert(gapEventsTable, [{id:"gap-event-m07",gapId:"gap-m07",status:"Open"}]);
  await insert(remediationPlansTable, [{id:"rem-m07",gapId:"gap-m07",title:"Commissioning record reinforcement",description:"Review and resubmit a complete commissioning record.",dueLabel:"This week"}]);
  await insert(remediationActivitiesTable, [{id:"rem-act-m07",planId:"rem-m07",title:"Review commissioning checklist",description:"Work through the annotated checklist with trainer.",type:"Coaching"}]);
  await insert(remediationEventsTable, [{id:"rem-event-m07",activityId:"rem-act-m07",status:"Not started"}]);
  }
  await insert(readinessGatesTable, [
    {id:"gate-g1",programId:"solar-pv-tech",pathwayId:"path-a",sequence:1,code:"G1",name:"Safety foundation",requirement:"Pass critical M03 safety criteria.",assessmentMode:"Mapped",evidenceMode:"None"},
    {id:"gate-g2",programId:"solar-pv-tech",pathwayId:"path-a",sequence:2,code:"G2",name:"Technical commissioning",requirement:"Valid commissioning evidence and no open critical gaps.",assessmentMode:"Mapped",evidenceMode:"Mapped"},
    {id:"gate-g3",programId:"solar-pv-tech",pathwayId:"path-a",sequence:3,code:"G3",name:"Work-ready",requirement:"All modules and evidence complete.",assessmentMode:"All",evidenceMode:"All"},
    {id:"gate-b1",programId:"solar-pv-tech",pathwayId:"path-b",sequence:1,code:"B1",name:"Design brief",requirement:"Translate the client brief into traceable design constraints.",assessmentMode:"Mapped",evidenceMode:"None"},
    {id:"gate-b2",programId:"solar-pv-tech",pathwayId:"path-b",sequence:2,code:"B2",name:"System design",requirement:"Complete sizing, yield, electrical, and structural design evidence.",assessmentMode:"Mapped",evidenceMode:"Mapped"},
    {id:"gate-b3",programId:"solar-pv-tech",pathwayId:"path-b",sequence:3,code:"B3",name:"Design assurance",requirement:"Pass the B07 design assurance assessment with no critical failures.",assessmentMode:"Mapped",evidenceMode:"None"},
    {id:"gate-b4",programId:"solar-pv-tech",pathwayId:"path-b",sequence:4,code:"B4",name:"Design-ready",requirement:"All Path B modules, evidence, and the client-ready design pack are complete.",assessmentMode:"All",evidenceMode:"All"},
  ]);
  for (const id of ["gate-g1", "gate-b1", "gate-b3"]) {
    await tx.update(readinessGatesTable).set({ assessmentMode:"Mapped", evidenceMode:"None" }).where(eq(readinessGatesTable.id, id));
  }
  for (const id of ["gate-g2", "gate-b2"]) {
    await tx.update(readinessGatesTable).set({ assessmentMode:"Mapped", evidenceMode:"Mapped" }).where(eq(readinessGatesTable.id, id));
  }
  for (const id of ["gate-g3", "gate-b4"]) {
    await tx.update(readinessGatesTable).set({ assessmentMode:"All", evidenceMode:"All" }).where(eq(readinessGatesTable.id, id));
  }
  if (includeDemoFixtures) {
    await insert(readinessEventsTable, [
      { id: "ready-demo-g1", enrollmentId: "enrol-demo", pathwayId: "path-a", gateId: "gate-g1", status: "Ready for Official Assessment", score: 55, blockers: [], decisionReason: "Demo fixture meets the published internal readiness rule.", createdAt: now },
      { id: "ready-demo-g2", enrollmentId: "enrol-demo", pathwayId: "path-a", gateId: "gate-g2", status: "Developing", score: 55, blockers: ["Commissioning evidence review pending"], decisionReason: "Demo fixture still requires commissioning evidence review.", createdAt: now },
    ]);
  }
  });
}
seed().then(() => process.stdout.write(`TERAS ${includeDemoFixtures ? "catalogue + demo" : "catalogue"} seed complete\n`)).catch((error: unknown) => { process.stderr.write(`${error}\n`); process.exitCode = 1; });
