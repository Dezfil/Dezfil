import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver, as the egress
// consumers' test answers it: one resolver serves the save and every use.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { PATCH } from "@/app/api/instance/settings/route";
import { egressBlockedError } from "@/lib/net/egress";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { testClient } from "@/lib/mcp/test-client";
import { resetSecretKeyCache } from "@/lib/secrets";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { admitServiceAddresses } from "./address-admission";
import { changeInstanceSettings } from "./change";
import { SERVICE_ADDRESS_KEYS, resolveServiceAddress } from "./service-address";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * An address an admin saves is refused at save when the egress policy would
 * refuse a request to it now, and kept when the allowlist names it or when
 * its name does not resolve; the refusal is the check's own sentence and
 * never repeats the address.
 */
const SEEDS = ["SEEDED-KEY-0001-USER", "SEEDED-KEY-0001-PATH", "SEEDED-KEY-0001-QUERY"];
const at = (host: string) => `http://seed-user:${SEEDS[0]}@${host}/${SEEDS[1]}?key=${SEEDS[2]}`;
const BLOCKED = `geocoderUrl: ${egressBlockedError().message}`;
const PUBLIC = [{ address: "203.0.113.10", family: 4 }];

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => {
  f = instanceSettingsFixture();
  vi.stubEnv("DEZFIL_SECRET_KEY", "3c".repeat(32)); resetSecretKeyCache();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue(PUBLIC);
});
afterEach(() => { f.close(); resetSecretKeyCache(); });

function dispatch(input: RequestInfo | URL, init?: RequestInit) {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${f.token.secret}`);
  return PATCH(socketRequest(new Request(incoming, { headers })));
}
function patch(body: unknown) {
  return PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: JSON.stringify(body) })));
}
const stored = () => f.db.prepare("SELECT key FROM workspace_settings ORDER BY key").all();
async function refusedAtSave(body: Record<string, unknown>, message = BLOCKED) {
  const response = await patch({ previewRows: 200, ...body });
  const text = await response.text();
  expect(response.status, text).toBe(400);
  expect(JSON.parse(text)).toEqual({ error: { code: "invalid_request", message } });
  for (const seed of SEEDS) expect(text).not.toContain(seed);
  expect(stored()).toEqual([]);
}
async function keptAtSave(key: string, address: string) {
  const response = await patch({ [key]: address });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(resolveServiceAddress(key as (typeof SERVICE_ADDRESS_KEYS)[number], f.db)).toEqual({ address, source: "stored" });
}

describe("a literal in blocked space", () => {
  it.each([
    ["loopback", "127.0.0.1"], ["loopback, elsewhere in its range", "127.8.9.10"], ["loopback in the other family", "[::1]"],
    ["the first private range", "10.0.0.5"], ["the second private range", "172.16.0.5"], ["the third private range", "192.168.1.5"],
    ["carrier-grade space", "100.64.0.5"], ["link-local space", "169.254.1.1"], ["the cloud metadata address", "169.254.169.254"],
    ["link-local space in the other family", "[fe80::1]"], ["unique-local space", "[fd00::1]"],
    ["the unspecified address", "0.0.0.0"], ["the unspecified address in the other family", "[::]"],
    ["multicast", "224.0.0.1"], ["multicast in the other family", "[ff02::1]"], ["reserved space", "240.0.0.1"], ["broadcast", "255.255.255.255"],
    ["a mapped loopback", "[::ffff:127.0.0.1]"], ["a mapped metadata address", "[::ffff:169.254.169.254]"],
    ["a NAT64 private address", "[64:ff9b::10.0.0.5]"], ["loopback written as one number", "2130706433"], ["loopback written in hex", "0x7f.0.0.1"],
  ])("is refused at save: %s (%s), naming the key with the check's sentence and repeating nothing", async (_name, host) => {
    await refusedAtSave({ geocoderUrl: at(host) });
    // A literal is checked as written, never looked up.
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each(SERVICE_ADDRESS_KEYS)("is refused for %s as for the others", async key => {
    await refusedAtSave({ [key]: at("127.0.0.1") }, `${key}: ${egressBlockedError().message}`);
  });

  it("is kept when the allowlist names it, by itself or by its range", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "10.0.0.5");
    await keptAtSave("geocoderUrl", at("10.0.0.5"));
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "fd00::/8");
    await keptAtSave("isochroneUrl", at("[fd00::1]"));
  });
});

describe("a name", () => {
  it.each([
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["private and loopback in both families", [{ address: "10.0.0.5", family: 4 }, { address: "::1", family: 6 }]],
    ["the cloud metadata address", [{ address: "169.254.169.254", family: 4 }]],
    ["a mapped private address", [{ address: "::ffff:192.168.1.5", family: 6 }]],
    ["a NAT64 loopback", [{ address: "64:ff9b::127.0.0.1", family: 6 }]],
  ])("whose every address resolves into blocked space (%s) is refused at save", async (_name, answers) => {
    dns.lookup.mockResolvedValue(answers);
    await refusedAtSave({ geocoderUrl: at("inside.example") });
    expect(dns.lookup).toHaveBeenCalledWith("inside.example", { all: true, verbatim: true });
  });

  it("with one public address among private ones is kept: the request goes to an address the check admits", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }, ...PUBLIC]);
    await keptAtSave("overpassUrl", at("mixed.example"));
  });

  it("that resolves into private space is kept when the allowlist names it, by name or by range", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "Private.Example");
    await keptAtSave("geocoderUrl", at("private.example"));
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "10.0.0.0/24");
    await keptAtSave("s3Endpoint", at("other-private.example"));
  });

  it.each([
    ["no such name", "ENOTFOUND"], ["no answer now", "EAI_AGAIN"],
  ])("that does not resolve at save (%s) is kept: every use checks again", async (_name, code) => {
    dns.lookup.mockRejectedValue(Object.assign(new Error(`getaddrinfo ${code} later.example`), { code }));
    await keptAtSave("isochroneUrl", at("later.example"));
  });
});

describe("the order of the checks", () => {
  it.each([
    ["another scheme", `ftp://127.0.0.1/${SEEDS[1]}`],
    ["2,049 characters", `http://inside.example/${SEEDS[1]}/${"a".repeat(2049 - 23 - SEEDS[1].length)}`],
  ])("refuses %s by the kind's reason before any lookup", async (_name, address) => {
    await refusedAtSave({ geocoderUrl: address }, "geocoderUrl: Expected an http or https address of at most 2048 characters.");
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("names every refused key at once, the kind's reasons and the check's, and stores nothing of the body", async () => {
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await refusedAtSave({ geocoderUrl: at("inside.example"), isochroneUrl: "ftp://router.example", overpassUrl: at("osm.example") },
      `isochroneUrl: Expected an http or https address of at most 2048 characters. geocoderUrl: ${egressBlockedError().message} overpassUrl: ${egressBlockedError().message}`);
  });

  it("leaves a locked address to its lock, never looking it up", async () => {
    vi.stubEnv("DEZFIL_GEOCODER_URL", "https://pinned.example");
    const response = await patch({ geocoderUrl: at("inside.example") });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "setting_locked", message: "geocoderUrl: Locked by DEZFIL_GEOCODER_URL." } });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("clears an address with null without a lookup", async () => {
    await keptAtSave("geocoderUrl", at("public.example"));
    dns.lookup.mockClear();
    expect((await patch({ geocoderUrl: null })).status).toBe(200);
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it("writes no address the save-time check did not see, or saw with another value", async () => {
    expect(() => changeInstanceSettings(f.context, { geocoderUrl: at("public.example") }, f.db)).toThrow("save-time check");
    const admission = await admitServiceAddresses({ geocoderUrl: at("public.example") });
    expect(() => changeInstanceSettings(f.context, { geocoderUrl: at("127.0.0.1") }, f.db, Date.now(), admission)).toThrow("save-time check");
    expect(stored()).toEqual([]);
    changeInstanceSettings(f.context, { geocoderUrl: at("public.example") }, f.db, Date.now(), admission);
    expect(stored()).toEqual([{ key: "instance.geocoderUrl" }]);
  });
});

describe("through the generated tool", () => {
  it("is refused at save for a loopback address and a name resolving into private space, and keeps an allowlisted one", async () => {
    const tool = buildTools().find(t => t.name === "update_instance_settings")!;
    const fetch = vi.fn(dispatch), client = await testClient(vi.fn((request: Request) => dispatch(request)));
    try {
      for (const address of [at("127.0.0.1"), at("inside.example")]) {
        dns.lookup.mockResolvedValue([{ address: "192.168.1.5", family: 4 }]);
        const result = await executeTool(tool, { geocoderUrl: address }, "http://instance.test", fetch);
        expect(result.status).toBe(400);
        const mcp = await client.callTool({ name: tool.name, arguments: { geocoderUrl: address } });
        expect(mcp.isError).toBe(true);
        const text = JSON.stringify([result, mcp]);
        expect(text).toContain("geocoderUrl: The requested address is not reachable from this server");
        for (const seed of SEEDS) expect(text).not.toContain(seed);
        expect(stored()).toEqual([]);
      }
      vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "inside.example");
      const kept = await executeTool(tool, { geocoderUrl: at("inside.example") }, "http://instance.test", fetch);
      expect(kept.status).toBe(200);
      expect(resolveServiceAddress("geocoderUrl", f.db)).toEqual({ address: at("inside.example"), source: "stored" });
    } finally { await client.close(); }
  });
});
