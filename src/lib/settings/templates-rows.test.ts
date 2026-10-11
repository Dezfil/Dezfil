import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver, as the egress
// consumers' tests answer it: one resolver serves the save and every use.
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
import { settingDefinition } from "./catalogue";
import { resolveTemplatesCatalogue } from "@/lib/templates/catalogue-address";
import { readStoredSettings } from "./store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * The two rows the template catalogue reads: whether it is used at all, a
 * switch stored with no variable; and where it is, an address stored
 * beside its variable on the service addresses' rules (write-only, refused
 * at save where the egress policy would refuse a request to it, read back as
 * its scheme and host), whose variable alone may name a folder on this
 * server instead, read back as a folder and never by its path.
 */
const SEEDS = ["SEEDED-KEY-0004-USER", "SEEDED-KEY-0004-PATH", "SEEDED-KEY-0004-QUERY", "SEEDED-KEY-0004-FOLDER"];
/** A catalogue at a host, its key in its user information, path and query. */
const at = (host: string) => `https://seed-user:${SEEDS[0]}@${host}/${SEEDS[1]}/index.json?key=${SEEDS[2]}`;
/** A folder on the server, named by the variable. */
const FOLDER = `/srv/${SEEDS[3]}/catalogue`;
const BLOCKED = `templatesCatalogueUrl: ${egressBlockedError().message}`;
const KIND = "templatesCatalogueUrl: Expected an http or https address of at most 2048 characters.";
const DEFAULT = "https://github.com/Dezfil/templates/releases/latest/download/index.json";
const PUBLIC = [{ address: "203.0.113.10", family: 4 }];

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
/** The admin's token on the change operation, as the API and the generated tools reach it. */
function dispatch(input: RequestInfo | URL, init?: RequestInit) {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${f.token.secret}`);
  return PATCH(socketRequest(new Request(incoming, { headers })));
}
const stored = () => f.db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all() as { key: string; value: string }[];
const readText = async () => (await GET(f.request())).text();
const read = async () => JSON.parse(await readText()).settings;
function expectNoSeed(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const seed of SEEDS) expect(text).not.toContain(seed);
}
async function refusedAtSave(body: Record<string, unknown>, message: string) {
  const response = await patch(body);
  const text = await response.text();
  expect(response.status, text).toBe(400);
  expect(JSON.parse(text)).toEqual({ error: { code: "invalid_request", message } });
  expectNoSeed(text);
  expect(stored()).toEqual([]);
}
async function keptAtSave(address: string) {
  const response = await patch({ templatesCatalogueUrl: address });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expectNoSeed(text);
  expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "address", address, source: "stored" });
}

describe("the switch", () => {
  it("is on by default, read by every signed-in account, changed by admins alone, with no variable", async () => {
    expect(settingDefinition("templates.catalogue")).toMatchObject({ scope: "instance", readBy: "signed-in", changedBy: "admin",
      kind: "boolean", defaultValue: true, documentedDefault: "on", editable: true, timing: "live", secret: false, write: { kind: "switch" } });
    expect(settingDefinition("templates.catalogue").environment).toBeUndefined();
    expect((await read())["templates.catalogue"]).toMatchObject({ value: true, source: "default", locked: false, storedValue: null });
  });

  it("is kept off and on again by an admin, and refused to a member", async () => {
    expect((await patch({ "templates.catalogue": false })).status).toBe(200);
    expect((await read())["templates.catalogue"]).toMatchObject({ value: false, source: "stored", storedValue: false });
    expect(readStoredSettings(f.db)).toEqual({ "templates.catalogue": false });
    const member = await patch({ "templates.catalogue": true }, `dezfil_session=${f.member.secret}`);
    expect(member.status).toBe(403);
    expect(readStoredSettings(f.db)["templates.catalogue"]).toBe(false);
    expect((await patch({ "templates.catalogue": true })).status).toBe(200);
    expect((await read())["templates.catalogue"]).toMatchObject({ value: true, source: "stored" });
  });

  it.each(["on", 1, "false"])("refuses %j, which is not true or false", async value => {
    const response = await patch({ "templates.catalogue": value });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "templates.catalogue: Expected true or false." } });
    expect(stored()).toEqual([]);
  });
});

describe("the catalogue address at save", () => {
  it("defaults to the release catalogue, read as its scheme and host", async () => {
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "address", address: DEFAULT, source: "default" });
    expect((await read()).templatesCatalogueUrl).toMatchObject({ value: { set: true, origin: "https://github.com" },
      defaultValue: { set: true, origin: "https://github.com" }, source: "default", locked: false, storedValue: null,
      environment: "DEZFIL_TEMPLATES_CATALOGUE", editable: true, readBy: "admin" });
  });

  it.each([
    ["a folder path", FOLDER],
    ["a relative folder", `catalogue/${SEEDS[3]}`],
    ["a file address", `file://${FOLDER}/index.json`],
    ["another scheme", at("catalogue.example").replace("https:", "ftp:")],
    ["2,049 characters", `${at("catalogue.example")}&pad=${"a".repeat(2049 - at("catalogue.example").length - 5)}`],
  ])("refuses %s from the page by the kind's reason, before any lookup, repeating nothing", async (_name, address) => {
    await refusedAtSave({ templatesCatalogueUrl: address }, KIND);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("refuses a folder by token through the API, the generated tool and MCP, repeating nothing", async () => {
    const byToken = await dispatch("http://instance.test/api/instance/settings", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ templatesCatalogueUrl: FOLDER }) });
    const text = await byToken.text();
    expect(byToken.status, text).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: { code: "invalid_request", message: KIND } });
    const tool = buildTools().find(t => t.name === "update_instance_settings")!;
    const fetch = vi.fn(dispatch), client = await testClient(vi.fn((request: Request) => dispatch(request)));
    try {
      const result = await executeTool(tool, { templatesCatalogueUrl: FOLDER }, "http://instance.test", fetch);
      expect(result.status).toBe(400);
      const mcp = await client.callTool({ name: tool.name, arguments: { templatesCatalogueUrl: FOLDER } });
      expect(mcp.isError).toBe(true);
      expectNoSeed([text, result, mcp]);
    } finally { await client.close(); }
    expect(stored()).toEqual([]);
  });

  it.each([
    ["loopback", "127.0.0.1"], ["loopback in the other family", "[::1]"], ["the first private range", "10.0.0.5"],
    ["the third private range", "192.168.1.5"], ["carrier-grade space", "100.64.0.5"], ["the cloud metadata address", "169.254.169.254"],
    ["unique-local space", "[fd00::1]"], ["the unspecified address", "0.0.0.0"], ["multicast", "224.0.0.1"], ["reserved space", "240.0.0.1"],
    ["a mapped loopback", "[::ffff:127.0.0.1]"], ["a NAT64 private address", "[64:ff9b::10.0.0.5]"], ["loopback written as one number", "2130706433"],
  ])("refuses a literal in blocked space (%s) with the egress check's sentence, never looking it up", async (_name, host) => {
    await refusedAtSave({ templatesCatalogueUrl: at(host) }, BLOCKED);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["private and loopback in both families", [{ address: "10.0.0.5", family: 4 }, { address: "::1", family: 6 }]],
    ["the cloud metadata address", [{ address: "169.254.169.254", family: 4 }]],
  ])("refuses a name whose every address resolves into blocked space (%s)", async (_name, answers) => {
    dns.lookup.mockResolvedValue(answers);
    await refusedAtSave({ templatesCatalogueUrl: at("inside.example") }, BLOCKED);
    expect(dns.lookup).toHaveBeenCalledWith("inside.example", { all: true, verbatim: true });
  });

  it("keeps a host the allowlist names, by name or by range, and a name that does not resolve now", async () => {
    dns.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "Catalogue.Internal");
    await keptAtSave(at("catalogue.internal"));
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "10.0.0.0/24");
    await keptAtSave(at("10.0.0.5"));
    dns.lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND later.example"), { code: "ENOTFOUND" }));
    await keptAtSave(at("later.example"));
  });

  it("is kept encrypted and read back as its scheme and host alone, the resolver alone giving the whole address", async () => {
    const response = await patch({ templatesCatalogueUrl: `  ${at("catalogue.example")}  ` });
    expect(response.status).toBe(200);
    const answer = JSON.parse(await response.text()).settings, again = await read();
    for (const settings of [answer, again]) {
      expectNoSeed(settings);
      expect(settings.templatesCatalogueUrl).toMatchObject({ value: { set: true, origin: "https://catalogue.example" }, source: "stored", locked: false, storedValue: null });
    }
    expect(stored()).toHaveLength(1);
    expectNoSeed(stored());
    expect(readStoredSettings(f.db)).not.toHaveProperty("templatesCatalogueUrl");
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "address", address: at("catalogue.example"), source: "stored" });
    // Removing it returns the catalogue to the release one.
    expect((await patch({ templatesCatalogueUrl: null })).status).toBe(200);
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "address", address: DEFAULT, source: "default" });
  });

  it("refuses with the coded unreadable refusal once the instance's key changes, never the default, and reads as set and unreadable", async () => {
    await keptAtSave(at("catalogue.example"));
    useKey("5e".repeat(32));
    expect(() => resolveTemplatesCatalogue(f.db)).toThrow(expect.objectContaining({ code: "service_address_unreadable" }));
    try { resolveTemplatesCatalogue(f.db); } catch (error) { expectNoSeed((error as Error).message); }
    expect((await read()).templatesCatalogueUrl).toMatchObject({ value: { set: true, unreadable: true }, source: "stored", storedValue: null });
  });

  it("is recorded by the assistant's projection as its scheme and host", () => {
    expect(recordedArguments({ templatesCatalogueUrl: at("catalogue.example"), "templates.catalogue": false }))
      .toEqual({ templatesCatalogueUrl: "https://catalogue.example", "templates.catalogue": false });
  });
});

describe("the catalogue address set by its variable", () => {
  it("reads an address as its scheme and host, locks the row and is the address in effect", async () => {
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", at("pinned.example"));
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "address", address: at("pinned.example"), source: "environment" });
    const text = await readText();
    expectNoSeed(text);
    expect(JSON.parse(text).settings.templatesCatalogueUrl).toMatchObject({ value: { set: true, origin: "https://pinned.example" },
      source: "environment", locked: true, invalidOverride: false });
    const refused = await patch({ templatesCatalogueUrl: at("catalogue.example") });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "setting_locked", message: "templatesCatalogueUrl: Locked by DEZFIL_TEMPLATES_CATALOGUE." } });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("names a folder on this server, read as a folder with no path, from the configuration read, the change answer and the tool", async () => {
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", FOLDER);
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "folder", folder: FOLDER, source: "environment" });
    const text = await readText();
    expectNoSeed(text);
    expect(JSON.parse(text).settings.templatesCatalogueUrl).toMatchObject({ value: { set: true, folder: true },
      source: "environment", locked: true, invalidOverride: false, storedValue: null });
    const answer = await patch({ "templates.catalogue": true });
    const answered = await answer.text();
    expect(answer.status).toBe(200);
    expectNoSeed(answered);
    expect(JSON.parse(answered).settings.templatesCatalogueUrl.value).toEqual({ set: true, folder: true });
    const client = await testClient(() => GET(f.request()));
    try {
      const result = await client.callTool({ name: "get_instance_settings", arguments: {} });
      expect(result.isError).not.toBe(true);
      expectNoSeed(result);
    } finally { await client.close(); }
  });

  it("takes a relative folder from the working directory", () => {
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", `catalogue/${SEEDS[3]}`);
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "folder", folder: path.resolve(`catalogue/${SEEDS[3]}`), source: "environment" });
  });

  it("keeps a stored address behind the folder, in effect again once the variable is gone", async () => {
    await keptAtSave(at("catalogue.example"));
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", FOLDER);
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "folder", folder: FOLDER, source: "environment" });
    vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", undefined);
    expect(resolveTemplatesCatalogue(f.db)).toEqual({ kind: "address", address: at("catalogue.example"), source: "stored" });
  });
});
