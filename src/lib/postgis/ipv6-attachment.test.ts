import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";

const io = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn(), lookup: vi.fn(), resolved: [] as string[][] }));
vi.mock("@/lib/duckdb", () => ({
  withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) =>
    work({ run: io.run, runAndReadAll: io.read } as unknown as DuckDBConnection),
}));
vi.mock("@/lib/net/egress", async (original) => {
  const actual = await original<typeof import("@/lib/net/egress")>();
  return { ...actual, resolveAllowed: async (host: string) => {
    const addresses = await actual.resolveAllowed(host, io.lookup);
    io.resolved.push(addresses);
    return addresses;
  } };
});
import { testConnection } from "./access";

const blocked = "The requested address is not reachable from this server: loopback, private-network, link-local, and metadata addresses are blocked by default. Specific hosts can be allowed with DEZFIL_EGRESS_ALLOWLIST.";
const target = { host: "", port: 5432, database: "gis", username: "reader", password: "fixture-secret", ssl: true };
const attachments = () => io.run.mock.calls.filter(([sql]) => String(sql).startsWith("ATTACH "));
beforeEach(() => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  io.run.mockReset().mockResolvedValue(undefined);
  io.read.mockReset().mockResolvedValue({ getRowObjects: () => [{ v: "fixture-version" }] });
  io.lookup.mockReset(); io.resolved.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

for (const arm of ["failure", "answer"] as const) {
  describe(`IPv6 connection boundary with lookup ${arm}`, () => {
    for (const literal of ["::1", "fd00::1", "2001:4860:4860::8888"]) {
      for (const host of [literal, `[${literal}]`]) {
        it(`${host} classifies without lookup and pins only the admitted literal`, async () => {
          io.lookup.mockImplementation(async () => {
            if (arm === "failure") throw Object.assign(new Error("injected lookup failure"), { code: "ENOTFOUND" });
            return [{ address: "2001:4860:4860::8844", family: 6 }];
          });
          const error = await testConnection({ ...target, host }).then(() => null, (e) => e);
          const pinned = attachments().map(([sql]) => String(sql).match(/hostaddr=''([^']+)''/)?.[1] ?? null);
          console.info(JSON.stringify({ arm, host, lookups: io.lookup.mock.calls, returned: io.resolved, error: error ? { status: error.status, code: error.code } : null, pinned }));
          expect.soft(io.lookup).not.toHaveBeenCalled();
          if (literal === "2001:4860:4860::8888") {
            expect.soft(error).toBeNull();
            expect.soft(io.resolved).toEqual([["2001:4860:4860::8888"]]);
            expect.soft(pinned).toEqual(["2001:4860:4860::8888"]);
          } else {
            expect.soft(error).toMatchObject({ status: 403, code: "egress_blocked", message: blocked });
            expect.soft(io.resolved).toEqual([]);
            expect.soft(io.run).not.toHaveBeenCalled();
            expect.soft(pinned).toEqual([]);
          }
        });
      }
    }
  });
}
