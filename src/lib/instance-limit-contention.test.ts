import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { instanceSettingsFixture } from "../../test-support/instance-settings";
import { race } from "../../test-support/instance-limit-race";
import { instanceCounts } from "./instance-limits";
import { writeStoredSettings } from "./settings/store";
import { createMap } from "./map-service";
import { testAccountScope } from "./test-support/accounts";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture({ file: true }); });
afterEach(() => f.close());

it.each(["maps", "projects", "people"] as const)("admits exactly one %s creation across independent connections", async kind => {
  const source = createMap(testAccountScope(f.db, "admin"), "Source");
  const before = instanceCounts(f.db);
  writeStoredSettings({ [`${kind}Limit`]: before[kind] + 1 }, f.db);
  const results = await race(f.dir, f.db.name, [0, 1, 2].map(index => ({ kind, name: `Contender${index}`, secret: f.admin.secret,
    map: { ...source, id: randomUUID(), name: `Contender${index}` } })));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok).map(result => result.code)).toEqual(["instance_limit_reached", "instance_limit_reached"]);
  expect(instanceCounts(f.db)).toEqual({ ...before, [kind]: before[kind] + 1 });
});
