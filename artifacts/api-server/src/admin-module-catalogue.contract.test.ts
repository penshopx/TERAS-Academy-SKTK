import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin module catalogue exposes every legacy code with explicit integrity states", async () => {
  const source = await readFile(new URL("./routes/programs.ts", import.meta.url), "utf8");
  assert.match(source, /"B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08"/);
  assert.match(source, /"missing"/);
  assert.match(source, /"incomplete"/);
  assert.match(source, /"mapped"/);
  assert.match(source, /mappings\.length !== 1/);
  assert.match(source, /authorizeAdmin/);
  assert.match(source, /GetAdminModuleCatalogueResponse\.parse/);
});