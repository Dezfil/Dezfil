import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { instanceSettingsFixture } from "../../test-support/instance-settings";
import { race } from "../../test-support/instance-limit-race";
import { buildTemplate, installFixture } from "../../test-support/templates/builder";
import { instanceCounts } from "./instance-limits";
import { writeStoredSettings } from "./settings/store";
import { createMap } from "./map-service";
import { testAccountScope } from "./test-support/accounts";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture({ file: true }); });
afterEach(() => f.close());

it.each([
  { kind: "createMap", count: "maps" },
  { kind: "duplicateMap", count: "maps" },
  { kind: "projects", count: "projects" },
  { kind: "people", count: "people" },
  { kind: "copyTemplate", count: "maps" },
  { kind: "copyTemplate", count: "projects" },
] as const)("admits exactly one $kind creation at the $count limit across independent connections", async ({ kind, count }) => {
  const source = createMap(testAccountScope(f.db, "admin"), "Source");
  const templateId = "contended-stations";
  if (kind === "copyTemplate") {
    const template = await buildTemplate(path.join(f.dir, "fixture"), { id: templateId });
    await installFixture(template, path.join(f.dir, "templates", templateId, "1"), { kind: "catalogue", origin: "https://catalogue.example" });
  }
  const before = instanceCounts(f.db);
  writeStoredSettings({ [`${count}Limit`]: before[count] + 1 }, f.db);
  const results = await race(f.dir, f.db.name, [0, 1, 2].map(index => ({ kind, name: `Contender${index}`, secret: f.admin.secret,
    sourceId: source.id, templateId })));
  expect(results.filter(result => result.ok), JSON.stringify(results)).toHaveLength(1);
  expect(results.filter(result => !result.ok).map(result => result.code), JSON.stringify(results)).toEqual(["instance_limit_reached", "instance_limit_reached"]);
  if (kind === "projects") expect(results.filter(result => !result.ok).map(result => result.status)).toEqual([409, 409]);
  const additions = kind === "copyTemplate" ? { maps: before.maps + 1, projects: before.projects + 1 } : { [count]: before[count] + 1 };
  expect(instanceCounts(f.db)).toEqual({ ...before, ...additions });
});
