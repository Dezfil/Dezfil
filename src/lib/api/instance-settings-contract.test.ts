import { expect, it, vi } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { admittedTools } from "@/lib/assistant/policy";
import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";

it("documents the complete admin read and exposes a local read-only tool with a closed input", async () => {
  const doc = buildOpenApiDocument();
  const operation = doc.paths["/api/instance/settings"].get;
  expect(operation.security).toEqual([{ CookieSession: [] }, { BearerToken: [] }]);
  expect(operation.description).toContain("current admin");
  expect(operation.description).toContain("private, no-store");
  for (const status of ["200", "401", "403", "503"]) expect(operation.responses).toHaveProperty(status);
  const schema = doc.components.schemas.InstanceSettings;
  expect(schema.properties.settings.properties.overpassUrl.properties).toMatchObject({
    documentedDefault: { const: "https://overpass-api.de/api/interpreter" },
    defaultValue: { const: { set: true, origin: "https://overpass-api.de" } },
  });
  expect(Object.keys(schema.properties.settings.properties).sort()).toEqual(SETTING_CATALOGUE.filter(d => d.scope !== "account").map(d => d.key).sort());
  const tool = buildTools().find(tool => tool.name === "get_instance_settings")!;
  expect(tool).toMatchObject({ path: "/api/instance/settings", method: "get", confirm: false,
    effects: { readOnly: true, writes: [] }, inputSchema: { type: "object", additionalProperties: false } });
  expect(tool.mcp).toEqual({ destructiveHint: false, openWorldHint: false, idempotentHint: true });
  expect(admittedTools("read_only")).toContain(tool);
  const dispatch = vi.fn();
  const result = await executeTool(tool, { seedUnknownArgument: "seed-argument-secret" }, "http://instance.test", dispatch);
  expect(result.status).toBe(400); expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("seed-argument-secret");
});
