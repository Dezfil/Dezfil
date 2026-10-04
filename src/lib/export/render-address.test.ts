import { afterEach, expect, it, vi } from "vitest";
import { admitRenderHost } from "./render-address";

afterEach(() => vi.unstubAllEnvs());
it("returns the whole admitted set from exactly one resolution", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(["203.0.113.7", "2001:db8::1"]).mockResolvedValue(["127.0.0.1"]);
  expect(await admitRenderHost("tiles.test", resolve)).toEqual({ verdict: "allow", addresses: ["203.0.113.7", "2001:db8::1"] });
  expect(resolve).toHaveBeenCalledExactlyOnceWith("tiles.test");
});
it("refuses the whole mixed set and checks literals without DNS", async () => {
  expect(await admitRenderHost("mixed.test", async () => ["203.0.113.7", "127.0.0.1"])).toEqual({ verdict: "deny" });
  const resolve = vi.fn();
  for (const host of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.169.254"]) {
    expect(await admitRenderHost(host, resolve)).toEqual({ verdict: "deny" });
  }
  expect(resolve).not.toHaveBeenCalled();
});
it.each([
  ["hostname", "tiles.test", "tiles.test", ["127.0.0.1", "::1"]],
  ["IP", "127.0.0.1", "tiles.test", ["127.0.0.1"]],
  ["CIDR", "127.0.0.0/8", "tiles.test", ["127.0.0.2"]],
])("preserves the %s exception", async (_kind, allowlist, host, addresses) => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", allowlist);
  expect(await admitRenderHost(host, async () => addresses)).toEqual({ verdict: "allow", addresses });
  expect(await admitRenderHost("unlisted.test", async () => ["10.0.0.1"])).toEqual({ verdict: "deny" });
  expect(await admitRenderHost("public.test", async () => ["203.0.113.7"])).toEqual({ verdict: "allow", addresses: ["203.0.113.7"] });
});
it("keeps dead names separate from policy refusals", async () => {
  expect(await admitRenderHost("dead.test", async () => [])).toEqual({ verdict: "unresolvable" });
  expect(await admitRenderHost("dead.test", async () => { throw Error("NXDOMAIN"); })).toEqual({ verdict: "unresolvable" });
});
