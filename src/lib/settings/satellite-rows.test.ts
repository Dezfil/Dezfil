import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver, as the egress
// consumers' test answers it: one resolver serves the save and every use.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { GET, PATCH } from "@/app/api/instance/settings/route";
import { egressBlockedError } from "@/lib/net/egress";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";
import { testClient } from "@/lib/mcp/test-client";
import { resetSecretKeyCache } from "@/lib/secrets";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { recordedArguments } from "@/lib/assistant/recorded-arguments";
import { resolveServiceAddress } from "./service-address";
import { readStoredSettings, writeStoredSettings } from "./store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * The rows Libraries draws: the five basemap switches, stored with no
 * variable; the satellite imagery's tile template, stored beside its
 * variable on the service addresses' rules, refused at save without its
 * placeholders, carrying user information (no browser loads tiles from
 * such an address) or where the egress policy would refuse a tile request
 * to it; and its credit, stored beside its variable as text.
 */
const SEEDS = ["SEEDED-KEY-0003-USER", "SEEDED-KEY-0003-PATH", "SEEDED-KEY-0003-QUERY"];
/** A template at a host, its key in the path and the query. */
const at = (host: string) => `https://${host}/${SEEDS[1]}/{z}/{x}/{y}.jpg?key=${SEEDS[2]}`;
const BLOCKED = `satelliteUrl: ${egressBlockedError().message}`;
const KIND = "satelliteUrl: Expected an http or https address of at most 2048 characters.";
const PUBLIC = [{ address: "203.0.113.10", family: 4 }];
const LONG = `${at("imagery.example")}&pad=${"a".repeat(2049 - at("imagery.example").length - 5)}`;

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => {
  f = instanceSettingsFixture();
  useKey("4d".repeat(32));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue(PUBLIC);
});
afterEach(() => { f.close(); resetSecretKeyCache(); });

function useKey(hex: string) { vi.stubEnv("DEZFIL_SECRET_KEY", hex); resetSecretKeyCache(); }
function patch(body: unknown, cookie = `dezfil_session=${f.admin.secret}`) {
  return PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie, origin: "http://instance.test", "content-type": "application/json" }, body: JSON.stringify(body) })));
}
function dispatch(input: RequestInfo | URL, init?: RequestInit) {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${f.token.secret}`);
  return PATCH(socketRequest(new Request(incoming, { headers })));
}
const stored = () => f.db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all() as { key: string; value: string }[];
const read = async () => (await (await GET(f.request())).json()).settings;
function expectNoSeed(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const seed of SEEDS) expect(text).not.toContain(seed);
}
async function refusedAtSave(body: Record<string, unknown>, message: string) {
  const response = await patch({ previewRows: 200, ...body });
  const text = await response.text();
  expect(response.status, text).toBe(400);
  expect(JSON.parse(text)).toEqual({ error: { code: "invalid_request", message } });
  expectNoSeed(text);
  expect(stored()).toEqual([]);
}
async function keptAtSave(template: string) {
  const response = await patch({ satelliteUrl: template });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expectNoSeed(text);
  expect(resolveServiceAddress("satelliteUrl", f.db)).toEqual({ address: template, source: "stored" });
}

describe("the tile template at save", () => {
  it("is measured at 2,049 characters where it is too long", () => expect(LONG).toHaveLength(2049));

  it.each([
    ["another scheme", at("imagery.example").replace("https:", "ftp:"), KIND],
    ["2,049 characters", LONG, KIND],
    ["no {z}", at("imagery.example").replace("{z}", "3"), "satelliteUrl: Expected {z}, {x} and {y} in the address; {z} is missing."],
    ["no {x}", at("imagery.example").replace("{x}", "3"), "satelliteUrl: Expected {z}, {x} and {y} in the address; {x} is missing."],
    ["no {y}", at("imagery.example").replace("{y}", "3"), "satelliteUrl: Expected {z}, {x} and {y} in the address; {y} is missing."],
    ["no placeholder at all", at("imagery.example").replace("/{z}/{x}/{y}", ""), "satelliteUrl: Expected {z}, {x} and {y} in the address; {z}, {x} and {y} are missing."],
  ])("refuses %s by its own reason, before any lookup, naming the key and repeating nothing", async (_name, template, message) => {
    await refusedAtSave({ satelliteUrl: template }, message);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("refuses a template without its placeholders even where its host is in blocked space: the kind's reason, never a lookup", async () => {
    await refusedAtSave({ satelliteUrl: at("127.0.0.1").replace("{y}", "3") }, "satelliteUrl: Expected {z}, {x} and {y} in the address; {y} is missing.");
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", "127.0.0.1"], ["loopback in the other family", "[::1]"], ["the first private range", "10.0.0.5"],
    ["the third private range", "192.168.1.5"], ["carrier-grade space", "100.64.0.5"], ["the cloud metadata address", "169.254.169.254"],
    ["unique-local space", "[fd00::1]"], ["the unspecified address", "0.0.0.0"], ["multicast", "224.0.0.1"], ["reserved space", "240.0.0.1"],
    ["a mapped loopback", "[::ffff:127.0.0.1]"], ["a NAT64 private address", "[64:ff9b::10.0.0.5]"], ["loopback written as one number", "2130706433"],
  ])("refuses a literal in blocked space (%s) with the egress check's sentence, never looking it up", async (_name, host) => {
    await refusedAtSave({ satelliteUrl: at(host) }, BLOCKED);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["private and loopback in both families", [{ address: "10.0.0.5", family: 4 }, { address: "::1", family: 6 }]],
    ["the cloud metadata address", [{ address: "169.254.169.254", family: 4 }]],
  ])("refuses a name whose every address resolves into blocked space (%s)", async (_name, answers) => {
    dns.lookup.mockResolvedValue(answers);
    await refusedAtSave({ satelliteUrl: at("inside.example") }, BLOCKED);
    expect(dns.lookup).toHaveBeenCalledWith("inside.example", { all: true, verbatim: true });
  });

  it("checks a template whose host holds a placeholder with each placeholder filled with a digit, as a tile request would reach it", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await refusedAtSave({ satelliteUrl: at("{z}.inside.example") }, BLOCKED);
    expect(dns.lookup).toHaveBeenCalledWith("0.inside.example", { all: true, verbatim: true });
  });

  it("keeps a host the allowlist names, by name or by range", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "Imagery.Internal");
    await keptAtSave(at("imagery.internal"));
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "10.0.0.0/24");
    await keptAtSave(at("10.0.0.5"));
  });

  it.each([["no such name", "ENOTFOUND"], ["no answer now", "EAI_AGAIN"]])("keeps a name that does not resolve at save (%s): every tile request checks again", async (_name, code) => {
    dns.lookup.mockRejectedValue(Object.assign(new Error(`getaddrinfo ${code} later.example`), { code }));
    await keptAtSave(at("later.example"));
  });

  it("leaves a template its variable locks to the lock, never looking it up", async () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://pinned.example/{z}/{x}/{y}.jpg");
    const response = await patch({ satelliteUrl: at("inside.example") });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "setting_locked", message: "satelliteUrl: Locked by DEZFIL_SATELLITE_URL." } });
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it("is refused at save through the generated tool and MCP, repeating nothing, and kept when allowlisted", async () => {
    const tool = buildTools().find(t => t.name === "update_instance_settings")!;
    const fetch = vi.fn(dispatch), client = await testClient(vi.fn((request: Request) => dispatch(request)));
    try {
      for (const template of [at("127.0.0.1"), at("inside.example")]) {
        dns.lookup.mockResolvedValue([{ address: "192.168.1.5", family: 4 }]);
        const result = await executeTool(tool, { satelliteUrl: template }, "http://instance.test", fetch);
        expect(result.status).toBe(400);
        const mcp = await client.callTool({ name: tool.name, arguments: { satelliteUrl: template } });
        expect(mcp.isError).toBe(true);
        expect(JSON.stringify([result, mcp])).toContain(BLOCKED);
        expectNoSeed([result, mcp]);
        expect(stored()).toEqual([]);
      }
      vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "inside.example");
      expect((await executeTool(tool, { satelliteUrl: at("inside.example") }, "http://instance.test", fetch)).status).toBe(200);
      expect(resolveServiceAddress("satelliteUrl", f.db)).toEqual({ address: at("inside.example"), source: "stored" });
    } finally { await client.close(); }
  });
});

/** A template on a public name whose key is in its user information too. */
const withUser = (user: string, host = "imagery.example") => `https://${user}@${host}/${SEEDS[1]}/{z}/{x}/{y}.jpg?key=${SEEDS[2]}`;
const CREDENTIALS = "satelliteUrl: A browser cannot load tiles from an address that carries a user name or password; put the key in the path or the query.";

describe("a tile template carrying user information", () => {
  it.each([
    ["a user name and a password", withUser(`seed-user:${SEEDS[0]}`)],
    ["a user name alone", withUser(SEEDS[0])],
    ["a password alone", withUser(`:${SEEDS[0]}`)],
  ])("is refused at save from the page with %s, saying where the key belongs, repeating nothing, before any lookup", async (_name, template) => {
    await refusedAtSave({ satelliteUrl: template }, CREDENTIALS);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("is refused by token through the API, the generated tool and MCP, repeating nothing", async () => {
    const template = withUser(`seed-user:${SEEDS[0]}`);
    const byToken = await dispatch("http://instance.test/api/instance/settings", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ satelliteUrl: template }) });
    const text = await byToken.text();
    expect(byToken.status, text).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: { code: "invalid_request", message: CREDENTIALS } });
    const tool = buildTools().find(t => t.name === "update_instance_settings")!;
    const fetch = vi.fn(dispatch), client = await testClient(vi.fn((request: Request) => dispatch(request)));
    try {
      const result = await executeTool(tool, { satelliteUrl: template }, "http://instance.test", fetch);
      expect(result.status).toBe(400);
      const mcp = await client.callTool({ name: tool.name, arguments: { satelliteUrl: template } });
      expect(mcp.isError).toBe(true);
      for (const answer of [result, mcp]) expect(JSON.stringify(answer)).toContain(CREDENTIALS);
      expectNoSeed([text, result, mcp]);
    } finally { await client.close(); }
    expect(stored()).toEqual([]);
  });

  it("stored before saves refused it, or set by the variable, still resolves and reads as carrying user information", async () => {
    const template = withUser(`seed-user:${SEEDS[0]}`);
    writeStoredSettings({ satelliteUrl: template }, f.db);
    expect(resolveServiceAddress("satelliteUrl", f.db)).toEqual({ address: template, source: "stored" });
    const kept = await read();
    expect(kept.satelliteUrl).toMatchObject({ value: { set: true, origin: "https://imagery.example", userInformation: true }, source: "stored", storedValue: null });
    vi.stubEnv("DEZFIL_SATELLITE_URL", withUser(`seed-user:${SEEDS[0]}`, "pinned.example"));
    const pinned = await read();
    expect(pinned.satelliteUrl).toMatchObject({ value: { set: true, origin: "https://pinned.example", userInformation: true }, source: "environment", locked: true });
    expectNoSeed([kept, pinned]);
  });

  it("is not said of a template without it, nor of a service address that carries it", async () => {
    const template = `https://imagery.example/${SEEDS[1]}/{z}/{x}/{y}.jpg?key=${SEEDS[2]}`;
    await keptAtSave(template);
    vi.stubEnv("DEZFIL_GEOCODER_URL", `https://seed-user:${SEEDS[0]}@geocoder.example/${SEEDS[1]}/search`);
    const settings = await read();
    expect(settings.satelliteUrl.value).toEqual({ set: true, origin: "https://imagery.example" });
    expect(settings.geocoderUrl.value).toEqual({ set: true, origin: "https://geocoder.example" });
  });
});

describe("a stored tile template", () => {
  it("is kept encrypted and read back as its scheme and host alone, the resolver alone giving the whole template", async () => {
    const response = await patch({ satelliteUrl: `  ${at("imagery.example")}  ` });
    expect(response.status).toBe(200);
    const answer = (await response.json()).settings, again = await read();
    for (const settings of [answer, again]) {
      expectNoSeed(settings);
      expect(settings.satelliteUrl).toMatchObject({ value: { set: true, origin: "https://imagery.example" }, source: "stored", locked: false, storedValue: null });
    }
    expect(stored()).toHaveLength(1);
    expectNoSeed(stored());
    expect(readStoredSettings(f.db)).not.toHaveProperty("satelliteUrl");
    expect(resolveServiceAddress("satelliteUrl", f.db)).toEqual({ address: at("imagery.example"), source: "stored" });
  });

  it("resolves to its variable while one is set, and to none while neither is", async () => {
    expect(resolveServiceAddress("satelliteUrl", f.db)).toEqual({ address: null, source: "default" });
    await keptAtSave(at("imagery.example"));
    vi.stubEnv("DEZFIL_SATELLITE_URL", "https://pinned.example/{z}/{x}/{y}.jpg");
    expect(resolveServiceAddress("satelliteUrl", f.db)).toEqual({ address: "https://pinned.example/{z}/{x}/{y}.jpg", source: "environment" });
    expect((await read()).satelliteUrl).toMatchObject({ value: { set: true, origin: "https://pinned.example" }, source: "environment", locked: true });
  });

  it("refuses with the coded unreadable refusal once the instance's key changes, never a default, and reads as set and unreadable", async () => {
    await keptAtSave(at("imagery.example"));
    useKey("5e".repeat(32));
    expect(() => resolveServiceAddress("satelliteUrl", f.db)).toThrow(expect.objectContaining({ code: "service_address_unreadable" }));
    try { resolveServiceAddress("satelliteUrl", f.db); } catch (error) { expectNoSeed((error as Error).message); }
    expect((await read()).satelliteUrl).toMatchObject({ value: { set: true, unreadable: true }, source: "stored", storedValue: null });
  });

  it("is recorded by the assistant's projection as its scheme and host", () => {
    expect(recordedArguments({ satelliteUrl: at("imagery.example"), satelliteAttribution: "© Provider" }))
      .toEqual({ satelliteUrl: "https://imagery.example", satelliteAttribution: "© Provider" });
    expect(recordedArguments({ satelliteUrl: [at("imagery.example")] })).toEqual({ satelliteUrl: "not an address" });
  });
});

describe("the satellite credit", () => {
  it("is stored beside its variable and read back as stored, then as the default once cleared", async () => {
    expect((await read()).satelliteAttribution).toMatchObject({ value: null, source: "default", locked: false, storedValue: null });
    expect((await patch({ satelliteAttribution: "  © Imagery Provider  " })).status).toBe(200);
    expect((await read()).satelliteAttribution).toMatchObject({ value: "© Imagery Provider", source: "stored", locked: false, storedValue: "© Imagery Provider" });
    expect(readStoredSettings(f.db)).toEqual({ satelliteAttribution: "© Imagery Provider" });
    expect((await patch({ satelliteAttribution: "" })).status).toBe(200);
    expect((await read()).satelliteAttribution).toMatchObject({ value: null, source: "default", storedValue: null });
  });

  it("reads its variable while one is set, locking the row and keeping the stored credit behind it", async () => {
    expect((await patch({ satelliteAttribution: "© Stored Provider" })).status).toBe(200);
    vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", "© Deployment Provider");
    expect((await read()).satelliteAttribution).toMatchObject({ value: "© Deployment Provider", source: "environment", locked: true, storedValue: "© Stored Provider" });
    const refused = await patch({ satelliteAttribution: "© Another" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "setting_locked", message: "satelliteAttribution: Locked by DEZFIL_SATELLITE_ATTRIBUTION." } });
  });

  it("refuses 161 characters, keeping what was stored", async () => {
    const response = await patch({ satelliteAttribution: "c".repeat(161) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "satelliteAttribution: Expected at most 160 characters." } });
    expect(readStoredSettings(f.db)).toEqual({});
  });
});

describe("the basemap switches", () => {
  const SWITCHES = ["basemaps.dark", "basemaps.light", "basemaps.streets", "basemaps.satellite", "basemaps.singleMapStyles"];

  it("read on by default, are kept off and on again by an admin, and are refused to a member", async () => {
    const before = await read();
    for (const key of SWITCHES) expect(before[key], key).toMatchObject({ value: true, source: "default", locked: false, storedValue: null });
    expect((await patch(Object.fromEntries(SWITCHES.map(key => [key, false])))).status).toBe(200);
    const after = await read();
    for (const key of SWITCHES) expect(after[key], key).toMatchObject({ value: false, source: "stored", storedValue: false });
    expect(readStoredSettings(f.db)).toEqual(Object.fromEntries(SWITCHES.map(key => [key, false])));
    expect((await patch({ "basemaps.streets": true })).status).toBe(200);
    expect((await read())["basemaps.streets"]).toMatchObject({ value: true, source: "stored" });
    const member = await patch({ "basemaps.dark": true }, `dezfil_session=${f.member.secret}`);
    expect(member.status).toBe(403);
    expect(readStoredSettings(f.db)["basemaps.dark"]).toBe(false);
  });

  it.each(["on", 1, "false"])("refuses %j, which is not true or false", async value => {
    const response = await patch({ "basemaps.satellite": value });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "basemaps.satellite: Expected true or false." } });
  });
});
