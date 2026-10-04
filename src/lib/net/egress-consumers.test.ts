import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), connected: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: io.lookup }));
vi.mock("node:http", () => ({ default: { request: io.request } }));
vi.mock("node:https", () => ({ default: { request: io.request } }));
import { isAddressAllowed, isBlockedIp, resolveAllowed, validatingLookup } from "./egress";
import { openRemote } from "./remote-fetch";
import { admitRenderRequest } from "@/lib/export/render-guard";

beforeEach(() => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  io.lookup.mockReset(); io.request.mockReset(); io.connected.mockReset();
  io.request.mockImplementation((url, options, respond) => {
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () => queueMicrotask(() => {
        const connect = (error: Error | null, address: string) => {
          if (error) { request.emit("error", error); return; }
          io.connected(address);
          respond(Object.assign(new PassThrough(), { statusCode: 200, headers: {} }));
        };
        if (options.lookup) options.lookup(url.hostname, {}, connect);
        else connect(null, url.hostname);
      }),
    });
    return request;
  });
});
afterEach(() => vi.unstubAllEnvs());

const ordinary: [string, boolean][] = [
  ["127.0.0.1", true], ["10.0.0.5", true], ["169.254.169.254", true],
  ["8.8.8.8", false], ["::1", true], ["fe80::1", true], ["fd00::1", true],
  ["2001:4860:4860::8888", false], ["::ffff:127.0.0.1", true],
  ["::ffff:8.8.8.8", false], ["64:ff9b::10.0.0.5", true], ["64:ff9b::8.8.8.8", false],
];
const scoped: [string, boolean][] = [
  ["::ffff:127.0.0.1%1", true], ["::ffff:10.0.0.5%eth0", true],
  ["::ffff:169.254.169.254%1", true], ["64:ff9b::127.0.0.1%1", true],
  ["64:ff9b::10.0.0.5%eth0", true], ["64:ff9b::169.254.169.254%1", true],
  ["::ffff:8.8.8.8%1", false], ["64:ff9b::8.8.8.8%eth0", false],
  ["::1%1", true], ["fe80::1%eth0", true], ["2001:4860:4860::8888%1", false],
];

for (const [kind, cases] of [["ordinary", ordinary], ["scoped", scoped]] as const) {
  describe(`${kind} addresses across egress consumers`, () => {
    it.each(cases)("classifies %s as blocked=%s", (address, blocked) => {
      expect(isBlockedIp(address)).toBe(blocked);
      expect(isAddressAllowed("destination.example", address)).toBe(!blocked);
    });
    it.each(cases)("keeps resolver and render admission for %s, blocked=%s", async (address, blocked) => {
      io.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
      if (blocked) await expect(resolveAllowed(address)).rejects.toMatchObject({ status: 403, code: "egress_blocked" });
      else await expect(resolveAllowed(address)).resolves.toEqual([address]);
      expect(io.lookup).not.toHaveBeenCalled();
      expect(await admitRenderRequest("https://tiles.example/tile", "http://app.example")).toBe(blocked ? "deny" : "allow");
      expect(io.lookup).toHaveBeenCalledWith("tiles.example", { all: true, verbatim: true });
    });
    it.each(cases)("keeps connect-time lookup and HTTP admission for %s, blocked=%s", async (address, blocked) => {
      io.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
      const lookup = validatingLookup("destination.example");
      const result = await new Promise<{ error: unknown; address: unknown }>((resolve) => {
        lookup("destination.example", { all: false }, (error, address) => resolve({ error, address }));
      });
      if (blocked) {
        expect(result.error).toMatchObject({ status: 403, code: "egress_blocked" });
        expect(result.address).toBe("");
        await expect(openRemote("https://destination.example/data")).rejects.toMatchObject({ status: 403, code: "egress_blocked" });
        expect(io.connected).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ error: null, address });
        const response = await openRemote("https://destination.example/data");
        expect(response.statusCode).toBe(200);
        response.body.destroy();
        expect(io.connected).toHaveBeenCalledWith(address);
      }
    });
  });
}

it.each(ordinary)("keeps literal HTTP and render admission for %s, blocked=%s", async (address, blocked) => {
  const url = `http://${address.includes(":") ? `[${address}]` : address}/data`;
  expect(await admitRenderRequest(url, "http://app.example")).toBe(blocked ? "deny" : "allow");
  const request = openRemote(url);
  if (blocked) {
    await expect(request).rejects.toMatchObject({ status: 403, code: "egress_blocked" });
    expect(io.request).not.toHaveBeenCalled();
  } else {
    const response = await request;
    expect(response.statusCode).toBe(200);
    response.body.destroy();
    expect(io.connected).toHaveBeenCalledOnce();
  }
  expect(io.lookup).not.toHaveBeenCalled();
});

it.each(["destination.example", "10.0.0.5", "10.0.0.0/24"])("retains the administrator exception %s across consumers", async (entry) => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", entry);
  io.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
  expect(isAddressAllowed("destination.example", "10.0.0.5")).toBe(true);
  expect(isAddressAllowed("other.example", "10.0.1.5")).toBe(false);
  await expect(resolveAllowed("destination.example")).resolves.toEqual(["10.0.0.5"]);
  expect(await admitRenderRequest("https://destination.example/tile", "http://app.example")).toBe("allow");
  const response = await openRemote("https://destination.example/data");
  expect(io.connected).toHaveBeenCalledWith("10.0.0.5");
  response.body.destroy();
});

it.each(["::ffff:127.0.0.1%", "::ffff:127.0.0.1%bad%zone", "not-an-ip%1"])("fails closed for malformed address %s", (address) => {
  expect(isBlockedIp(address)).toBe(true);
  expect(isAddressAllowed("destination.example", address)).toBe(false);
});

it("does not let a scope suffix manufacture an allowlist match", () => {
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "::ffff:127:0/128");
  expect(isAddressAllowed("destination.example", "::ffff:127.0.0.1%1")).toBe(false);
});
