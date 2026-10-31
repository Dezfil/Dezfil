import { afterEach, beforeEach, expect, it } from "vitest";
import { instanceSettingsFixture } from "../../test-support/instance-settings";
import { createMap } from "./map-service";
import { createProject } from "./metadata/owned-projects";
import { testAccountScope } from "./test-support/accounts";
import { changeInstanceSettings } from "./settings/change";
import { instanceCounts } from "./instance-limits";
import { dispatchAssistantTestRoute } from "./assistant/testing/route-dispatch";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());

it("keeps existing work usable below the count, including sharing, publication, export and ownership changes", async () => {
  const scope = testAccountScope(f.db, "admin");
  const project = createProject(scope, { name: "Shared work" }, f.db);
  createProject(scope, { name: "Another project" }, f.db);
  const map = createMap(scope, "Filed map", project.id);
  createMap(scope, "Another map");
  const before = instanceCounts(f.db);
  changeInstanceSettings(f.context, { mapsLimit: 1, projectsLimit: 1, peopleLimit: 1 }, f.db);
  expect(instanceCounts(f.db)).toEqual(before);
  const request = (method: string, path: string, body?: object, revision?: string, member = false) => dispatchAssistantTestRoute(new Request(`http://instance.test${path}`, {
    method, headers: { origin: "http://instance.test", cookie: `dezfil_session=${member ? f.member.secret : f.admin.secret}`,
      "content-type": "application/json", ...(revision ? { "X-Edit-Revision": revision } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const checked = async (response: Promise<Response>, status = 200) => {
    const result = await response;
    const body = result.status === 204 ? null : await result.json();
    expect(result.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  for (const path of ["/api/maps", "/api/projects", "/api/users"]) {
    await checked(request("POST", path, { name: "Refused", email: "another@example.test" }), 409);
  }
  const read = await checked(request("GET", `/api/maps/${map.id}`));
  const edited = await checked(request("PATCH", `/api/maps/${map.id}`, { name: "Kept map" }, read.editRevision));
  await checked(request("PATCH", `/api/projects/${project.id}`, { note: "Kept note" }));
  await checked(request("PUT", `/api/projects/${project.id}/people/member`, { role: "editor" }));
  expect((await checked(request("GET", `/api/maps/${map.id}`, undefined, undefined, true))).name).toBe("Kept map");
  const published = await checked(request("POST", `/api/maps/${map.id}/publish`, {}, edited.editRevision), 201);
  const unpublished = await checked(request("DELETE", `/api/maps/${map.id}/publish`, undefined, published.editRevision));
  const exported = await request("POST", `/api/projects/${project.id}/export`, { maps: [map.id], file: "kept-work" });
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-type")).toBe("application/zip");
  expect((await exported.arrayBuffer()).byteLength).toBeGreaterThan(0);
  const transferred = await checked(request("POST", `/api/maps/${map.id}/transfer`, { to: "member" }, unpublished.editRevision));
  await checked(request("POST", `/api/projects/${project.id}/transfer`, { to: "member" }));
  expect(instanceCounts(f.db)).toEqual(before);
  await checked(request("DELETE", `/api/maps/${map.id}`, undefined, transferred.editRevision, true), 204);
  await checked(request("DELETE", `/api/projects/${project.id}`, undefined, undefined, true));
  expect(instanceCounts(f.db)).toEqual({ maps: 1, projects: 1, people: 2 });
});
