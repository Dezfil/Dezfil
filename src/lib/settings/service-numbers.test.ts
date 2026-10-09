import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { readInstanceSettings } from "./read";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * The services' numbers an admin may store beside their variables, each in
 * its variable's own unit: kept in range, refused outside it naming the key
 * and the reason with nothing stored, and locked by a set variable.
 */
const NUMBERS = {
  geocodePaceMs: { min: 0, max: 60_000, variable: "DEZFIL_GEOCODE_PACE_MS" },
  geocodeRequestTimeoutS: { min: 1, max: 120, variable: "DEZFIL_GEOCODE_REQUEST_TIMEOUT_S" },
  geocodeMatchCacheHours: { min: 24, max: 8_760, variable: "DEZFIL_GEOCODE_MATCH_CACHE_HOURS" },
  isochronePaceMs: { min: 0, max: 60_000, variable: "DEZFIL_ISOCHRONE_PACE_MS" },
  isochroneRequestTimeoutS: { min: 1, max: 120, variable: "DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S" },
  isochroneCacheHours: { min: 24, max: 8_760, variable: "DEZFIL_ISOCHRONE_CACHE_HOURS" },
  overpassTimeoutS: { min: 10, max: 900, variable: "DEZFIL_OVERPASS_TIMEOUT_S" },
  overpassCacheHours: { min: 1, max: 720, variable: "DEZFIL_OVERPASS_CACHE_H" },
} as const;
const ROWS = Object.entries(NUMBERS).map(([key, bounds]) => ({ key, ...bounds }));

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());

function patch(body: unknown) {
  return PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: JSON.stringify(body) })));
}
const setting = (key: string) => readInstanceSettings(f.context, f.db).settings[key] as { value: unknown; source: string; storedValue: unknown; locked: boolean };

describe("each service number", () => {
  it.each(ROWS)("$key keeps $min and $max, in its variable's unit", async ({ key, min, max }) => {
    for (const value of [min, max]) {
      const response = await patch({ [key]: value });
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()).settings[key]).toMatchObject({ value, source: "stored", storedValue: value, locked: false });
      expect(setting(key)).toMatchObject({ value, source: "stored", storedValue: value });
    }
    const cleared = await patch({ [key]: null });
    expect(cleared.status).toBe(200);
    expect(setting(key)).toMatchObject({ source: "default", storedValue: null });
  });

  it.each(ROWS)("$key refuses a value outside $min to $max, naming the key and the reason, and stores nothing", async ({ key, min, max }) => {
    const kept = min + 1;
    expect((await patch({ [key]: kept })).status).toBe(200);
    for (const value of [min - 1, max + 1, min + 0.5, String(max)]) {
      const response = await patch({ [key]: value });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request",
        message: `${key}: Expected a whole number from ${min} to ${max}.` } });
      expect(setting(key)).toMatchObject({ value: kept, source: "stored", storedValue: kept });
    }
  });

  it.each(ROWS)("$key is locked by a set $variable", async ({ key, min, variable }) => {
    vi.stubEnv(variable, String(min + 2));
    const response = await patch({ [key]: min + 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "setting_locked", message: `${key}: Locked by ${variable}.` } });
    expect(setting(key)).toMatchObject({ value: min + 2, source: "environment", locked: true, storedValue: null });
  });
});
