import { afterEach, expect, it, vi } from "vitest";
import { settingRemedy } from "./remedy";

afterEach(() => vi.unstubAllEnvs());
it.each([undefined, ""])("offers an admin change with an absent or empty variable (%s)", value => {
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", value);
  expect(settingRemedy("queryTimeoutS")).toBe('An admin can change "Query time limit".');
});
it.each(["5", "invalid-private-text"])("reports the lock even when the override is rejected (%s)", value => {
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", value);
  expect(settingRemedy("queryTimeoutS")).toBe('Change DEZFIL_QUERY_TIMEOUT_S and restart to change "Query time limit".');
  expect(settingRemedy("queryTimeoutS")).not.toContain(value);
});
