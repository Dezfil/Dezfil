import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../test-support/instance-settings";
import { testAccountScope } from "./test-support/accounts";
import { createMap } from "./map-service";
import { createProject } from "./metadata/owned-projects";
import { writeStoredSettings } from "./settings/store";
import { instanceCounts } from "./instance-limits";
import { dispatchAssistantTestRoute } from "./assistant/testing/route-dispatch";
import { testClient } from "./mcp/test-client";
import { recordCreationAttempt } from "../../test-support/instance-limit-assistant";

let f: ReturnType<typeof instanceSettingsFixture>, mapId: string;
beforeEach(() => {
  f = instanceSettingsFixture();
  const scope = testAccountScope(f.db, "admin");
  mapId = createMap(scope, "Original").id;
  createProject(scope, { name: "Original project" }, f.db);
  writeStoredSettings({ mapsLimit: 1, projectsLimit: 1, peopleLimit: 2 }, f.db);
});
afterEach(() => f.close());

const roads = [
  { tool: "create_map", path: () => "/api/maps", args: () => ({ name: "Refused" }), key: "mapsLimit", count: 1 },
  { tool: "duplicate_map", path: () => `/api/maps/${mapId}/duplicate`, args: () => ({ id: mapId }), key: "mapsLimit", count: 1 },
  { tool: "create_project", path: () => "/api/projects", args: () => ({ name: "Refused" }), key: "projectsLimit", count: 1 },
  { tool: "invite_user", path: () => "/api/users", args: () => ({ name: "Refused", email: "invite@example.test" }), key: "peopleLimit", count: 2 },
];
const call = (road: typeof roads[number], token: boolean) => dispatchAssistantTestRoute(new Request(`http://instance.test${road.path()}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "http://instance.test",
    ...(token ? { authorization: `Bearer ${f.token.secret}` } : { cookie: `dezfil_session=${f.admin.secret}` }) }, body: JSON.stringify(road.args()),
}));

describe("instance creation admission", () => {
  it.each(roads)("$tool refuses both session and token requests without creating anything", async road => {
    const before = instanceCounts(f.db);
    for (const token of [false, true]) {
      const response = await call(road, token);
      expect(response.status).toBe(409);
      const { error } = await response.json();
      expect(error).toMatchObject({ code: "instance_limit_reached", key: road.key, limit: road.count, count: road.count });
      expect(error.message).toContain("This instance holds its limit of");
      expect(error.message).toContain("An admin can change");
      expect(instanceCounts(f.db)).toEqual(before);
    }
  });

  it("names the locked variable in the remedy", async () => {
    vi.stubEnv("DEZFIL_MAPS_LIMIT", "1");
    const response = await call(roads[0], false);
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("Change DEZFIL_MAPS_LIMIT and restart");
  });

  it("returns the same refusal through the stock MCP client and real API dispatch", async () => {
    const client = await testClient(request => {
      request.headers.set("authorization", `Bearer ${f.token.secret}`);
      return dispatchAssistantTestRoute(request);
    });
    try {
      for (const road of roads) {
        const direct = await (await call(road, true)).json();
        const result = await client.callTool({ name: road.tool, arguments: road.args() });
        expect(result.isError, road.tool).toBe(true);
        expect(result.structuredContent, road.tool).toMatchObject({ result: direct });
      }
      expect(instanceCounts(f.db)).toEqual({ maps: 1, projects: 1, people: 2 });
    } finally { await client.close(); }
  });

  it.each(roads)("records a refused $tool assistant action through its real request", async road => {
    const result = await recordCreationAttempt(testAccountScope(f.db, "admin"), f.context, road.tool, road.args());
    expect(result.actions).toMatchObject([{ tool: road.tool, status: "refused" }]);
    expect(result.outcome).toMatchObject({ error: { code: "instance_limit_reached", key: road.key } });
    expect(instanceCounts(f.db)).toEqual({ maps: 1, projects: 1, people: 2 });
  });
});
