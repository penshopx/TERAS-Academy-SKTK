import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntegrationTestApp } from "./integration-test-app";
import { ListAdminRegulatoryReferencesResponse } from "@workspace/api-zod";

const openapi = readFileSync(new URL("../../../lib/api-spec/openapi.yaml", import.meta.url), "utf8");
assert.match(openapi, /\/admin\/competency-frameworks:\s+get:[\s\S]*?post:\s+operationId: createAdminCompetencyFramework/);
assert.match(openapi, /\/admin\/regulatory-references:\s+get:/);
assert.doesNotMatch(openapi.slice(openapi.indexOf("/admin/regulatory-references:"), openapi.indexOf("/admin/competency-frameworks/{frameworkId}")), /\n\s+post:/);

async function request(role: "admin" | "learner" | null) {
  const app = createIntegrationTestApp(() => ({ userId: role ? `${role}-regulatory-test` : null, role }));
  const listener = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
  const address = listener.address();
  assert(address && typeof address !== "string");
  try {
    return await fetch(`http://127.0.0.1:${address.port}/api/admin/regulatory-references`);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}

const unauthenticated = await request(null);
assert.equal(unauthenticated.status, 401);
const learner = await request("learner");
assert.equal(learner.status, 403);
const admin = await request("admin");
assert.equal(admin.status, 200);
const body = ListAdminRegulatoryReferencesResponse.parse(await admin.json());
assert.equal(body.length, 2);
assert.deepEqual(body.map(item => item.authorityRole).sort(), ["DOMAIN_AUTHORITY", "REGULATORY_CONTEXT"]);
assert.deepEqual(body.map(item => item.contentSha256).sort(), [
  "299a649b262dcea59931727adce93e562b2cd609af9c5e7e7d518d853f502429",
  "827b2da42b6c78af3d55ec69f70cdc624eabd8aef32474698dd0326b6f038ca2",
]);
const serialized = JSON.stringify(body);
assert.equal(/attached_assets|\/home\/|\/tmp\/|base64|JVBER|%PDF/i.test(serialized), false);
for (const item of body) {
  assert.equal("sourcePath" in item, false);
  assert.equal("documentBytes" in item, false);
}
console.log("Regulatory references API integration passed");