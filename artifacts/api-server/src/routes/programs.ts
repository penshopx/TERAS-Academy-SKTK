import { Router, type IRouter } from "express";
import { GetAdminModuleCatalogueResponse, GetModuleParams, GetModuleResponse, GetProgramParams, GetProgramResponse, ListPracticeTasksResponse, ListProgramsResponse } from "@workspace/api-zod";
import { assessmentSummary, baselineForModule, catalogue, learnerContext, moduleSummary, pathwaySummary, progressByModule, selectedBaselineModuleIds } from "../lib/teras";
import { authorizeAdmin, authorizeLearner } from "../lib/authorization";

const router: IRouter = Router();
const legacyModuleCodes = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08"] as const;

export function adminModuleCatalogue(source: Awaited<ReturnType<typeof catalogue>>) {
  const canonicalModules = source.baselineModules
    .filter(module => /^M(0[1-9]|10)$/.test(module.code))
    .sort((a, b) => a.sequence - b.sequence)
    .map(module => ({ id: module.id, code: module.code, name: module.name, status: module.status }));

  const legacyModules = legacyModuleCodes.map(legacyCode => {
    const legacyModule = source.modules.find(module => module.code === legacyCode);
    const mappings = legacyModule
      ? source.legacyMappings.filter(item => item.legacyModuleId === legacyModule.id)
      : [];
    const mapping = mappings.length === 1 ? mappings[0] : undefined;
    const target = mapping
      ? source.baselineModules.find(module => module.id === mapping.baselineModuleId)
      : undefined;
    const mappingStatus = mappings.length === 0 ? "missing" : mappings.length !== 1 || !legacyModule || !target ? "incomplete" : "mapped";
    return {
      legacyCode,
      legacyName: legacyModule?.name ?? null,
      retiredStatus: "retired",
      mappingStatus,
      targetCode: target?.code ?? null,
      targetName: target?.name ?? null,
      note: mapping?.note ?? null,
    };
  });

  return { canonicalModules, legacyModules };
}

router.get("/admin/module-catalogue", async (req, res): Promise<void> => {
  if (!await authorizeAdmin(req, res)) return;
  const response = adminModuleCatalogue(await catalogue());
  const incompleteCount = response.legacyModules.filter(module => module.mappingStatus !== "mapped").length;
  if (incompleteCount) req.log.warn({ incompleteCount }, "Legacy module catalogue contains missing or incomplete mappings");
  res.json(GetAdminModuleCatalogueResponse.parse(response));
});

router.get("/programs", async (req, res): Promise<void> => {
  req.log.info("Listing programs");
  const { programs, modules, enrollments } = await catalogue();
  res.json(ListProgramsResponse.parse(programs.map(p => ({...p,moduleCount:modules.filter(m=>m.programId===p.id).length,learnerCount:new Set(enrollments.filter(e=>e.programId===p.id).map(e=>e.learnerId)).size}))));
});
router.get("/programs/:programId", async (req,res): Promise<void> => {
  const parsed=GetProgramParams.safeParse(req.params); if(!parsed.success){req.log.warn("Invalid program id");res.status(400).json({error:parsed.error.message});return;}
  const learnerId=await authorizeLearner(req,res); if(!learnerId)return;
  const source=await catalogue(), {programs,paths,modules,enrollments}=source, program=programs.find(p=>p.id===parsed.data.programId);
  if(!program){res.status(404).json({error:"Program not found"});return;}
  const context = await learnerContext(learnerId);
  const selected = await selectedBaselineModuleIds(context.pathway.id, context.baselineVersionId);
  const activeModules = modules.filter(m=>m.programId===program.id&&selected.has(m.id));
  const progress=await progressByModule(learnerId);
  const pathwayViews=await Promise.all(paths.filter(p=>p.id===context.pathway.id&&p.programId===program.id).map(p=>pathwaySummary(p.id, source, context.baselineVersionId)));
  res.json(GetProgramResponse.parse({...program,moduleCount:activeModules.length,learnerCount:new Set(enrollments.filter(e=>e.programId===program.id).map(e=>e.learnerId)).size,pathways:pathwayViews.filter((pathway):pathway is NonNullable<typeof pathway>=>Boolean(pathway)),modules:activeModules.sort((a,b)=>a.sequence-b.sequence).map(m=>{const baseline=baselineForModule(m.id,source);const contract=source.pathwayContracts.find(item=>item.pathwayId===context.pathway.id&&item.moduleId===(baseline?.moduleId??m.id));return moduleSummary(m,progress(m.id).progress,progress(m.id).status,context.pathway.id,baseline,contract);})}));
});
router.get("/modules/:moduleId", async(req,res):Promise<void>=>{
  const parsed=GetModuleParams.safeParse(req.params);if(!parsed.success){res.status(400).json({error:parsed.error.message});return;}
  const learnerId=await authorizeLearner(req,res);if(!learnerId)return;
   const [source,context]=await Promise.all([catalogue(),learnerContext(learnerId)]), {pathway}=context, {modules,tasks,requirements,assessments}=source, module=modules.find(m=>m.id===parsed.data.moduleId);
   // M01-M10 are shared baseline records. Their stable teras_modules rows
   // retain Path A ownership for historical FKs, while Path B reaches them
   // through the additive baseline mapping.
   const baseline=module ? baselineForModule(module.id,source) : undefined;
   const sharedBaselineId = baseline?.moduleId === module?.id ? baseline?.id : undefined;
    const selectedIds = await selectedBaselineModuleIds(pathway.id, context.baselineVersionId);
    const sharedSelection = sharedBaselineId
      ? selectedIds.has(module!.id)
     : false;
   if(!module|| (module.pathwayId!==pathway.id && !sharedSelection)){res.status(404).json({error:"Module not found for the enrolled pathway"});return;}
  const progress=await progressByModule(learnerId), assessment=assessments.find(a=>a.moduleId===module.id);
  if(!assessment){res.status(404).json({error:"Module assessment not found"});return;}
   const contract=source.pathwayContracts.find(item=>item.pathwayId===pathway.id&&item.moduleId===(baseline?.moduleId??module.id));
   res.json(GetModuleResponse.parse({module:moduleSummary(module,progress(module.id).progress,progress(module.id).status,pathway.id,baseline,contract),learningOutcomes:module.learningOutcomes,theory:module.theory,practiceTasks:tasks.filter(t=>t.moduleId===module.id).map(t=>({...t,status:"Available"})),assessment:await assessmentSummary(assessment,learnerId,pathway.id),evidenceRequirement:requirements.find(r=>r.moduleId===module.id)}));
});
router.get("/practice/tasks",async(req,res):Promise<void>=>{req.log.info("Listing practice tasks");const learnerId=await authorizeLearner(req,res);if(!learnerId)return;const [{tasks},context]=await Promise.all([catalogue(),learnerContext(learnerId)]);const moduleIds=await selectedBaselineModuleIds(context.pathway.id, context.baselineVersionId);res.json(ListPracticeTasksResponse.parse(tasks.filter(t=>moduleIds.has(t.moduleId)).map(t=>({...t,status:"Available"}))));});
export default router;