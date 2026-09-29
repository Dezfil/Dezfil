import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { PUT } from "@/app/api/tables/[name]/geometry/route";
import { POST } from "@/app/api/tables/[name]/geometry/preview/route";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { inspectGeometry, previewGeometry } from "./service";
import { geometryRevision } from "./read";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";

vi.mock("@/lib/duckdb", async original => ({ ...await original<typeof import("@/lib/duckdb")>(), trustedH3Ready: async () => false }));
let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { await cleanupGeometryTest(dir); });
it("unavailable H3 is an unvalidated candidate and prevents explicit application", async () => {
  const t = await stored("SELECT '8928308280fffff' payload");
  expect(await inspectGeometry(testAccountScope(), t.name)).toMatchObject({ candidates: [{ format: "h3", applied: false, strength: "weak", sample: { readable: null }, reasons: ["h3-unavailable"] }] });
  expect(await previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "h3", columns: ["payload"] })).toMatchObject({ canApply: false, issues: [{ code: "h3_unavailable" }] });
  const context={params:Promise.resolve({name:t.name})};
  const request=(method:string)=>new Request("http://dezfil.test",{method,body:JSON.stringify({expectedRevision:geometryRevision(t),choice:{format:"h3",columns:["payload"]}})});
  const response=await POST(testAccountRequest(request("POST")),context); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({canApply:false,issues:[{code:"h3_unavailable"}]});
  const refused=await PUT(testAccountRequest(request("PUT")),context);expect(refused.status).toBe(422);
  expect(await refused.json()).toMatchObject({error:{code:"geometry_choice_invalid",issues:[{code:"h3_unavailable"}]}});
});
it.each(["missing", "corrupt"])("a %s artifact fails instead of counting rows unreadable", async fault => {
  const t = await stored("SELECT 'bad' payload");
  const file = path.join(process.env.DEZFIL_DATA_DIR!, t.file);
  if (fault === "missing") await rm(file); else await writeFile(file, "not parquet");
  await expect(previewGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] })).rejects.toThrow();
});
