import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { externalFixture } from "../../../test-support/external-sign-in";
import * as metadata from "@/lib/metadata/db";
import { readGenerations } from "@/lib/metadata/auth-generations";
import { register } from "@/instrumentation";

let f: ReturnType<typeof externalFixture>;
beforeEach(() => {
  f = externalFixture(); vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "");
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "0");
});
afterEach(() => f.close());
function mode(enabled: boolean) {
  if (!enabled) { vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", undefined); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", undefined); }
  Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
}
it.each([true, false])("the startup hook applies a reset before serving, with external sign-in enabled: %s", async enabled => {
  mode(enabled); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", "7");
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "11");
  f.db.exec("UPDATE auth_generations SET door_generation=9007199254740991");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await register();
  expect(readGenerations(f.db)).toEqual({ sign_out_generation: 1, door_generation: enabled ? 11 : 7 });
  expect(f.db.prepare("SELECT value FROM auth_door_generation_resets").all()).toEqual([{ value: 7 }]);
  expect(log).toHaveBeenCalledExactlyOnceWith("[auth] Door generation reset to 7; every session and token ended.");
});
for (const enabled of [true, false]) it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e3", "0x7", "+7", "invalid"])(
  `refuses malformed reset %j before opening the store, with external sign-in enabled: ${enabled}`, async value => {
    mode(enabled); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET", value);
    const open = vi.spyOn(metadata, "metadataDb"), log = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = f.snapshot();
    await expect(register()).rejects.toThrow("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET must be a non-negative safe whole number.");
    expect(open).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
    expect(log).toHaveBeenCalledExactlyOnceWith("[auth] DEZFIL_EXTERNAL_SIGN_IN_GENERATION_RESET must be a non-negative safe whole number.");
  },
);
