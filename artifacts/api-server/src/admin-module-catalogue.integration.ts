import { pool } from "@workspace/db";
import { createIntegrationTestApp } from "./integration-test-app";

type LegacyModule = {
  legacyCode: string;
  legacyName: string | null;
  mappingStatus: "mapped" | "missing" | "incomplete";
  targetCode: string | null;
  targetName: string | null;
  note: string | null;
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function requestCatalogue(role: "admin" | "learner") {
  const app = createIntegrationTestApp(() => ({ userId: `${role}-catalogue-test`, role }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/module-catalogue`);
    return {
      status: response.status,
      body: await response.json() as { legacyModules?: LegacyModule[]; error?: string },
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function legacyByCode(modules: LegacyModule[], code: string) {
  const module = modules.find(item => item.legacyCode === code);
  assert(module, `Catalogue did not include ${code}`);
  return module;
}

async function run() {
  const learner = await requestCatalogue("learner");
  assert(learner.status === 403, "A non-admin user must not read the administrative catalogue");

  const admin = await requestCatalogue("admin");
  assert(admin.status === 200, `Administrator catalogue request failed with ${admin.status}`);
  assert(admin.body.legacyModules?.length === 8, "Administrator catalogue must include all eight legacy codes");

  const modules = admin.body.legacyModules;
  const mapped = legacyByCode(modules, "B01");
  assert(mapped.mappingStatus === "mapped", "A valid legacy mapping was not reported as mapped");
  assert(mapped.targetCode === "M01" && mapped.targetName === "Canonical 1", "Mapped target details were not projected");
  assert(mapped.note === "Valid mapping", "Mapped note was not projected");

  const missing = legacyByCode(modules, "B02");
  assert(missing.mappingStatus === "missing", "A legacy module without a mapping was not reported as missing");
  assert(missing.targetCode === null && missing.note === null, "A missing mapping exposed target details");

  const orphaned = legacyByCode(modules, "B03");
  assert(orphaned.mappingStatus === "incomplete", "A mapping with an orphaned target was not reported as incomplete");
  assert(orphaned.targetCode === null, "An orphaned target was projected as a canonical module");

  const duplicated = legacyByCode(modules, "B04");
  assert(duplicated.mappingStatus === "incomplete", "Duplicate legacy mappings were not reported as incomplete");
  assert(duplicated.targetCode === null && duplicated.note === null, "Duplicate mappings selected an arbitrary winner");
}

await run().finally(async () => pool.end());