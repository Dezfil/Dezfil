import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { changeInstanceSettings } from "./change";
import { readInstanceSettings } from "./read";
import { countLimitValues, tokenLifetimeMax } from "./instance-limit-values";
import { resolveNumericSetting } from "./resolver";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());

describe("instance limit rows", () => {
  it.each([
    ["mapsLimit", "DEZFIL_MAPS_LIMIT"], ["projectsLimit", "DEZFIL_PROJECTS_LIMIT"], ["peopleLimit", "DEZFIL_PEOPLE_LIMIT"],
  ] as const)("%s defaults to none, saves whole counts live and locks beside its variable", (key, variable) => {
    expect(readInstanceSettings(f.context, f.db).settings[key]).toMatchObject({ value: 0, locked: false });
    expect(changeInstanceSettings(f.context, { [key]: 2 }, f.db).settings[key]).toMatchObject({ value: 2, source: "stored" });
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => changeInstanceSettings(f.context, { [key]: value }, f.db)).toThrow(expect.objectContaining({ code: "invalid_request" }));
      vi.stubEnv(variable, String(value));
      expect(resolveNumericSetting(key)).toMatchObject({ value: 0, locked: true, invalidOverride: true });
      vi.stubEnv(variable, undefined);
    }
    vi.stubEnv(variable, "3");
    expect(readInstanceSettings(f.context, f.db).settings[key]).toMatchObject({ value: 3, storedValue: 2, locked: true });
    expect(() => changeInstanceSettings(f.context, { [key]: 4 }, f.db)).toThrow(expect.objectContaining({ code: "setting_locked" }));
    vi.stubEnv(variable, "0");
    expect(readInstanceSettings(f.context, f.db).settings[key]).toMatchObject({ value: 0, locked: true });
    vi.stubEnv(variable, "");
    expect(changeInstanceSettings(f.context, { [key]: null }, f.db).settings[key]).toMatchObject({ value: 0, source: "default" });
  });

  it("resolves the count limits from the supplied store without activating a process snapshot", () => {
    expect(countLimitValues(f.db)).toEqual({ maps: 0, projects: 0, people: 0 });
    changeInstanceSettings(f.context, { mapsLimit: 2, projectsLimit: 3, peopleLimit: 4 }, f.db);
    expect(countLimitValues(f.db)).toEqual({ maps: 2, projects: 3, people: 4 });
    expect(tokenLifetimeMax({ tokenLifetimeMax: "90d" }).value).toBe("90d");
  });

  it("stores the lifetime bound as a choice, independent of the token rule, with a deployment lock", () => {
    expect(readInstanceSettings(f.context, f.db).settings.tokenLifetimeMax.value).toBe("none");
    for (const value of ["30d", "90d", "1y", "none"]) {
      expect(changeInstanceSettings(f.context, { tokenLifetimeMax: value }, f.db).settings.tokenLifetimeMax.value).toBe(value);
    }
    expect(() => changeInstanceSettings(f.context, { tokenLifetimeMax: "never" }, f.db)).toThrow(expect.objectContaining({ code: "invalid_request" }));
    changeInstanceSettings(f.context, { tokenLifetimeMax: "1y" }, f.db);
    vi.stubEnv("DEZFIL_TOKEN_LIFETIME_MAX", "30d");
    expect(readInstanceSettings(f.context, f.db).settings.tokenLifetimeMax).toMatchObject({ value: "30d", storedValue: "1y", locked: true });
    expect(() => changeInstanceSettings(f.context, { tokenLifetimeMax: "none" }, f.db)).toThrow(expect.objectContaining({ code: "setting_locked" }));
    vi.stubEnv("DEZFIL_TOKEN_LIFETIME_MAX", "invalid");
    expect(readInstanceSettings(f.context, f.db).settings.tokenLifetimeMax).toMatchObject({ value: "none", invalidOverride: true, locked: true });
  });
});
