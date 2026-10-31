import { afterEach, beforeEach, expect, it } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { instanceSettingsFixture } from "../../test-support/instance-settings";
import { GET } from "@/app/api/config/route";
import { GET as getSettings } from "@/app/api/instance/settings/route";
import { createMap } from "./map-service";
import { createProject } from "./metadata/owned-projects";
import { testAccountScope } from "./test-support/accounts";
import { changeInstanceSettings } from "./settings/change";
import { readInstanceSettings } from "./settings/read";
import { buildTools } from "./tools/tools";
import { INSTANCE_LIMITS_SCHEMA } from "./api/openapi-instance-limits";
import { testClient } from "./mcp/test-client";
import { dispatchAssistantTestRoute } from "./assistant/testing/route-dispatch";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());
const validate = async (schema: object | boolean, value: unknown) => {
  const validator = fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0]);
  expect((await validator["~standard"].validate(value)).issues).toBeUndefined();
};

it("gives every signed-in account the same aggregate limits and counts, including private content", async () => {
  const scope = testAccountScope(f.db, "admin");
  createMap(scope, "Private map"); createProject(scope, { name: "Private project" }, f.db);
  const expected = { maps: { key: "mapsLimit", limit: 0, count: 1 }, projects: { key: "projectsLimit", limit: 0, count: 1 },
    people: { key: "peopleLimit", limit: 0, count: 2 }, tokenLifetimeMax: "none" };
  for (const secret of [f.admin.secret, f.member.secret]) {
    const response = await GET(f.request({ cookie: `dezfil_session=${secret}` }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    const result = (await response.json()).instanceLimits;
    expect(result).toEqual(expected); await validate(INSTANCE_LIMITS_SCHEMA, result);
    expect(JSON.stringify(result)).not.toContain("Private");
  }
  const settings = readInstanceSettings(f.context, f.db);
  expect(settings.instanceLimits).toEqual(expected);
  await validate(buildTools().find(tool => tool.name === "get_instance_settings")!.rawOutputSchema!, await (await getSettings(f.request())).json());
});

it("reports a live limit below the count without deleting anything, and narrows the tool's settings response", async () => {
  const scope = testAccountScope(f.db, "admin");
  createMap(scope, "First"); createMap(scope, "Second");
  changeInstanceSettings(f.context, { mapsLimit: 1, peopleLimit: 1, tokenLifetimeMax: "90d" }, f.db);
  const client = await testClient(request => {
    request.headers.set("authorization", `Bearer ${f.token.secret}`);
    return dispatchAssistantTestRoute(request);
  });
  try {
    for (const name of ["get_config", "get_instance_settings"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ result: { instanceLimits: {
        maps: { limit: 1, count: 2 }, people: { limit: 1, count: 2 }, tokenLifetimeMax: "90d",
      } } });
    }
    await validate(buildTools().find(tool => tool.name === "get_instance_settings")!.rawOutputSchema!, await (await getSettings(f.request())).json());
  } finally { await client.close(); }
});
