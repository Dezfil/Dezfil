import { beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { testClient } from "@/lib/mcp/test-client";
import { renderGuidance } from "../../../scripts/dezfil-guidance.mjs";
import { checkServedContract } from "../../../scripts/served-contract-checks.mjs";
const read = (file: string) => readFileSync(file, "utf8");
let tools: { name: string }[];
beforeAll(async () => {
  const client = await testClient(() => Response.json({}));
  try { tools = (await client.listTools()).tools; } finally { await client.close(); vi.unstubAllGlobals(); }
});
function observed() {
  return { document: buildOpenApiDocument(), sourceDocument: buildOpenApiDocument(), tools, derivedTools: buildTools(),
    docs: { api: read("docs/api.md"), mcp: read("docs/mcp.md"), proof: read("docs/testing/account-deletion-guidance.md") }, baseline: JSON.parse(read("test-support/assistant-baselines/mcp-tools-list.json")),
    guidance: read("plugins/dezfil/skills/dezfil/analysis.md"), expectedGuidance: renderGuidance() };
}
it("accepts the actual generated server listing and committed readers through the outside checker", () => {
  expect(checkServedContract(observed())).toEqual([]);
});
it.each(["count", "error", "actor", "plugin", "tool"])("rejects %s drift in the outside checker's actual inputs", seed => {
  const values = observed(); let failure: string;
  if (seed === "count") {
    // One more path than the reader says, whatever it says today.
    const paths = Number(/\*\*(\d+) paths,/.exec(values.docs.api)![1]);
    values.docs.api = values.docs.api.replace(`**${paths} paths,`, `**${paths + 1} paths,`);
    failure = `API paths: reader says ${paths + 1}, contract requires ${paths}`;
  }
  else if (seed === "error") { values.docs.api = values.docs.api.replace("| `deletion_changed` |", "| `missing_deletion_changed` |"); failure = "Reader error catalogue has missing or extra codes"; }
  else if (seed === "actor") { values.document.components.schemas.RecipeRun.properties.runner.oneOf.splice(1, 1); failure = "Actor schema differs: RecipeRun.runner"; }
  else if (seed === "plugin") { values.guidance = values.guidance.replace("## account-departures", "## stale-departures"); failure = "Installed plugin guidance is stale"; }
  else { values.tools = values.tools.map((tool, index) => index ? tool : { ...tool, description: "Dropped consequence" }); failure = `Served MCP definition differs: ${values.tools[0].name}`; }
  expect(checkServedContract(values)).toContain(failure);
});
