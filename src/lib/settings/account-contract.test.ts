import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import * as catalogue from "./catalogue";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { GET, PATCH } from "@/app/api/settings/route";
import { settingsContract } from "@/lib/api/openapi-settings";
import { setAccountViewPrefs } from "@/lib/metadata/account-preferences";
import { setInstanceName } from "@/lib/metadata/settings";

let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function request(account: string, body?: unknown) {
  return testAccountRequest(new Request("http://instance.test/api/settings", {
    method: body === undefined ? "GET" : "PATCH",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  }), db, account);
}
const read = async (account: string) => (await GET(request(account))).json();
const patch = (account: string, body: unknown) => PATCH(request(account, body));
const cases = [
  ["maps.view", "grid", "list"], ["maps.sort", "edited", "name"],
  ["data.view", "grid", "list"], ["data.sort", "updated", "size"],
  ["workflows.view", "grid", "list"], ["workflows.sort", "edited", "created"],
  ["projects.view", "grid", "list"], ["projects.sort", "updated", "largest"],
  ["sourceGrouping", "person", "project"],
];
it.each(cases)("uses the %s definition for validation and both schema positions", async (key, rejected, accepted) => {
  const original = catalogue.settingDefinition;
  vi.spyOn(catalogue, "settingDefinition").mockImplementation(name => name === key
    ? { ...original(name), write: { kind: "choice", values: [accepted] } } : original(name));
  const [screen, field] = key.split(".");
  const body = (value: string) => field ? { viewPrefs: { [screen]: { [field]: value } } } : { sourceGrouping: value };
  const before = await read("alice");
  expect((await patch("alice", { displayName: "Must not land", ...body(rejected) })).status).toBe(400);
  expect(await read("alice")).toEqual(before);
  expect((await patch("alice", body(accepted))).status).toBe(200);
  const contract = settingsContract();
  const bodySchema = contract.paths["/api/settings"].patch.requestBody as {
    content: { "application/json": { schema: { properties: typeof contract.schemas.WorkspaceSettings.properties } } };
  };
  for (const properties of [contract.schemas.WorkspaceSettings.properties,
    bodySchema.content["application/json"].schema.properties]) {
    const choice = field ? properties.viewPrefs.properties[screen as "maps"].properties[field as "view"] : properties.sourceGrouping;
    expect(choice.enum).toEqual([accepted]);
  }
});

it("keeps the complete legacy document and isolates each account's merged preferences", async () => {
  expect(await read("alice")).toEqual({ displayName: "alice", instanceName: null, viewPrefs: {}, sourceGrouping: "person" });
  expect(await read("bob")).toEqual({ displayName: "bob", instanceName: null, viewPrefs: {}, sourceGrouping: "person" });
  setInstanceName("Field atlas", db);
  setAccountViewPrefs("bob", { maps: { sort: "retained-legacy-sort" } }, db);
  const bob = { displayName: "bob", instanceName: "Field atlas", viewPrefs: { maps: { sort: "retained-legacy-sort" } }, sourceGrouping: "person" };
  expect(await read("bob")).toEqual(bob);
  const saved = await patch("alice", { displayName: " Alice ", sourceGrouping: "project", viewPrefs: {
    maps: { view: "list", sort: "name" }, data: { sort: "rows" }, workflows: { view: "grid" }, projects: { sort: "largest" },
  } });
  const expected = { displayName: "Alice", instanceName: "Field atlas", sourceGrouping: "project", viewPrefs: {
    maps: { view: "list", sort: "name" }, data: { sort: "rows" }, workflows: { view: "grid" }, projects: { sort: "largest" },
  } };
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual(expected);
  expect(await read("alice")).toEqual(expected);
  const merged = await patch("alice", { viewPrefs: { maps: { sort: "created" } } });
  expect(await merged.json()).toEqual({ ...expected, viewPrefs: { ...expected.viewPrefs, maps: { view: "list", sort: "created" } } });
  expect(await read("bob")).toEqual(bob);
});
