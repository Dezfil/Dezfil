import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The engine's own lookup, answered by a fixture resolver: one resolver
// serves the save-time check and the inspection's connection alike.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { POST } from "@/app/api/instance/basemaps/route";
import { DELETE, PATCH } from "@/app/api/instance/basemaps/[id]/route";
import { GET as readConfig } from "@/app/api/config/route";
import { GET as readSettings } from "@/app/api/instance/settings/route";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { resumeAssistant, runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { egressBlockedError } from "@/lib/net/egress";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { instanceSettingsFixture } from "../../test-support/instance-settings";

/**
 * The basemap library: an admin adds a style by its address, the server
 * reads it once at the add (the egress check first, then one inspection),
 * keeps its credit or its host, and offers it to everyone choosing a
 * basemap. Nothing reads the address again. Hidden and removed through
 * their own operations; admins only on every road; the embedded assistant
 * asks first and the SQL and workflow assistants are never offered it.
 */

// Every style address here is a loopback fixture; a request sent anywhere
// else fails its test before it leaves this machine.
keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
const SEEDS = ["SEEDED-KEY-0006-PATH", "SEEDED-KEY-0006-QUERY"];
const BLOCKED = egressBlockedError().message;
const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];
const PUBLIC = [{ address: "203.0.113.10", family: 4 }];

const style = (attribution?: string) => ({
  version: 8, name: "Fixture chart",
  sources: { chart: { type: "raster", tiles: ["http://127.0.0.1/chart/{z}/{x}/{y}.png"], tileSize: 256, ...(attribution ? { attribution } : {}) } },
  layers: [{ id: "chart", type: "raster", source: "chart" }],
});

let f: ReturnType<typeof instanceSettingsFixture>;
let fixture: Server;
/** Every request the style fixture answered, by path. */
let asked: string[];
let port: number;

beforeEach(async () => {
  f = instanceSettingsFixture();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue(LOOPBACK);
  asked = [];
  fixture = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    asked.push(path);
    if (path.startsWith("/credited/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(style('© <a href="https://charts.example/terms">Fixture Charts</a>'))); return; }
    if (path.startsWith("/plain/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(style())); return; }
    if (path.startsWith("/not-a-style/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "FeatureCollection", features: [] })); return; }
    res.writeHead(404); res.end("missing");
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", () => resolve()));
  port = (fixture.address() as AddressInfo).port;
});
afterEach(async () => {
  fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve()));
  f.close();
});

/** A style address at the fixture, a key seeded in its path and query. */
const at = (kind: string, host = "127.0.0.1") => `http://${host}:${port}/${kind}/${SEEDS[0]}/style.json?key=${SEEDS[1]}`;

const admin = () => ({ cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN, "content-type": "application/json" });
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = admin()) {
  return socketRequest(new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
const add = (body: unknown, headers?: Record<string, string>) => POST(call("POST", "/api/instance/basemaps", body, headers));
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const offer = (id: string, offered: unknown, headers?: Record<string, string>) => PATCH(call("PATCH", `/api/instance/basemaps/${id}`, { offered }, headers), params(id));
const remove = (id: string, headers?: Record<string, string>) => DELETE(call("DELETE", `/api/instance/basemaps/${id}`, undefined, headers), params(id));
const rows = () => f.db.prepare("SELECT id, name, url, attribution, offered FROM basemap_styles ORDER BY position").all();

/** The runtime read, as a member's page load reads it. */
async function runtime() {
  const response = await readConfig(call("GET", "/api/config", undefined, { cookie: `dezfil_session=${f.member.secret}` }));
  expect(response.status).toBe(200);
  return (await response.json()) as { basemapStyles: unknown[] };
}
/** The configuration read, as System's page reads it. */
async function configuration() {
  const response = await readSettings(call("GET", "/api/instance/settings", undefined, { authorization: `Bearer ${f.token.secret}` }));
  expect(response.status).toBe(200);
  return (await response.json()) as { basemapStyles: unknown[] };
}

async function refused(body: unknown, message: string | RegExp) {
  const response = await add(body);
  const text = await response.text();
  expect(response.status, text).toBe(400);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(JSON.parse(text)).toEqual({ error: { code: "invalid_request", message: expect.stringMatching(message) } });
  for (const seed of SEEDS) expect(text).not.toContain(seed);
  return text;
}

describe("adding a style", () => {
  it("keeps a valid style with its credit after exactly one request, and reads it again nowhere", async () => {
    const response = await add({ name: "  Harbour chart ", url: `  ${at("credited")}  ` });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const added = await response.json();
    expect(added).toEqual({ id: expect.any(String), name: "Harbour chart", url: at("credited"), offered: true, addedAt: expect.any(String),
      attribution: [{ label: "© Fixture Charts", href: "https://charts.example/terms" }] });
    expect(asked).toEqual([`/credited/${SEEDS[0]}/style.json`]);

    // Every account's runtime read offers it, the configuration read lists
    // it; page loads read the row, never the address.
    for (let load = 0; load < 3; load++) {
      expect((await runtime()).basemapStyles).toEqual([{ id: added.id, name: "Harbour chart", url: at("credited"), attribution: added.attribution }]);
      expect((await configuration()).basemapStyles).toEqual([added]);
    }
    expect(asked).toHaveLength(1);
  });

  it("keeps a style that names no credit with its host", async () => {
    dns.lookup.mockResolvedValue(LOOPBACK);
    const response = await add({ name: "Grey", url: at("plain", "styles.fixture.test") });
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json()).attribution).toEqual([{ label: "styles.fixture.test" }]);
    expect(dns.lookup).toHaveBeenCalledWith("styles.fixture.test", { all: true, verbatim: true });
    expect(asked).toHaveLength(1);
  });

  it("refuses an answer that is not a style, keeping nothing", async () => {
    await refused({ name: "Points", url: at("not-a-style") }, /^The address did not answer with a MapLibre style\. /);
    expect(asked).toHaveLength(1);
    expect(rows()).toEqual([]);
  });

  it("refuses a style it cannot read now, with no force, keeping nothing", async () => {
    await refused({ name: "Gone", url: at("gone") }, /^The style could not be read now, so it was not added\. It answered HTTP 404\. /);
    expect(asked).toHaveLength(1);
    // A port nothing answers on.
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", () => resolve()));
    const dead = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const text = await refused({ name: "Dead", url: `http://127.0.0.1:${dead}/${SEEDS[0]}/style.json?key=${SEEDS[1]}`, force: undefined },
      /^The style could not be read now, so it was not added\. The library/);
    expect(text).not.toContain(String(dead));
    expect(await refused({ name: "Forced", url: at("gone"), force: true }, /^Give the style's name and its url, and nothing else\.$/)).toBeTruthy();
    expect(rows()).toEqual([]);
  });

  it.each([
    ["loopback", "127.0.0.2"], ["the first private range", "10.0.0.5"], ["the cloud metadata address", "169.254.169.254"],
    ["loopback in the other family", "[::1]"], ["unique-local space", "[fd00::1]"], ["loopback written in hex", "0x7f.0.0.2"],
    ["a mapped loopback", "[::ffff:127.0.0.2]"], ["the unspecified address", "0.0.0.0"],
  ])("refuses an address in blocked space (%s) with the check's sentence, before any request", async (_name, host) => {
    await refused({ name: "Inside", url: `http://${host}:${port}/credited/${SEEDS[0]}/style.json?key=${SEEDS[1]}` }, new RegExp(`^${BLOCKED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(asked).toEqual([]);
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("refuses a name all of whose addresses resolve into blocked space, before any request", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await refused({ name: "Inside", url: at("credited", "inside.fixture.test") }, BLOCKED);
    expect(asked).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("refuses a name that answered publicly at the check and privately at the connection, sending nothing", async () => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    dns.lookup.mockResolvedValueOnce(PUBLIC).mockResolvedValue(LOOPBACK);
    await refused({ name: "Rebound", url: at("credited", "rebound.fixture.test") }, /^The egress policy blocks this host\./);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(asked).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("refuses an address the library holds, and a fifty-first style, before any request", async () => {
    expect((await add({ name: "Harbour", url: at("credited") })).status).toBe(201);
    await refused({ name: "Harbour again", url: ` ${at("credited")} ` }, /^The library already holds a style at this address\.$/);
    expect(asked).toHaveLength(1);

    const insert = f.db.prepare("INSERT INTO basemap_styles (id, name, url, attribution, offered, position, created_at) VALUES (?, ?, ?, '[]', 1, ?, ?)");
    for (let n = 1; n < 50; n++) insert.run(`seeded-${n}`, `Seeded ${n}`, `http://127.0.0.1:${port}/seeded/${n}/style.json`, n + 1, new Date(n).toISOString());
    expect(rows()).toHaveLength(50);
    await refused({ name: "Fifty-first", url: at("plain") }, /^The library holds 50 styles, its most\. Remove one before adding another\.$/);
    expect(asked).toHaveLength(1);
    expect(rows()).toHaveLength(50);
  });

  it.each([
    [{ name: "", url: "http://127.0.0.1/style.json" }, /^name must be 1 to 60 characters\.$/],
    [{ name: "n".repeat(61), url: "http://127.0.0.1/style.json" }, /^name must be 1 to 60 characters\.$/],
    [{ name: "Chart", url: `ftp://127.0.0.1/${SEEDS[0]}?key=${SEEDS[1]}` }, /^url must be an http or https address with a host\.$/],
    [{ name: "Chart", url: `http://127.0.0.1/${"p".repeat(2049 - "http://127.0.0.1/".length)}` }, /^url must be at most 2,048 characters\.$/],
    [{ name: "Chart", url: "not an address" }, /^url must be an http or https address with a host\.$/],
    [{ name: "Chart" }, /^url must be an http or https address with a host\.$/],
    [{ name: "Chart", url: "http://127.0.0.1/style.json", offered: false }, /^Give the style's name and its url, and nothing else\.$/],
    [["Chart", "http://127.0.0.1/style.json"], /^Give the style's name and its url, and nothing else\.$/],
  ])("refuses a malformed add (%#), before any request", async (body, message) => {
    await refused(body, message);
    expect(asked).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("keeps an address of exactly 2,048 characters", async () => {
    const url = at("plain");
    const long = `${url}&pad=${"p".repeat(2048 - url.length - "&pad=".length)}`;
    expect(long).toHaveLength(2048);
    expect((await add({ name: "Long", url: long })).status).toBe(201);
  });
});

describe("offering, hiding and removing", () => {
  it("hides a style from the runtime read, keeps it in the configuration read, and offers it again", async () => {
    const first = await (await add({ name: "Harbour", url: at("credited") })).json();
    const second = await (await add({ name: "Grey", url: at("plain") })).json();
    const hidden = await offer(first.id, false);
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("cache-control")).toBe("private, no-store");
    expect(await hidden.json()).toEqual({ ...first, offered: false });
    expect((await runtime()).basemapStyles).toEqual([{ id: second.id, name: "Grey", url: at("plain"), attribution: second.attribution }]);
    expect((await configuration()).basemapStyles).toEqual([{ ...first, offered: false }, second]);

    expect(await (await offer(first.id, true)).json()).toEqual(first);
    expect((await runtime()).basemapStyles).toHaveLength(2);

    const removed = await remove(first.id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect((await configuration()).basemapStyles).toEqual([second]);
    expect((await runtime()).basemapStyles).toEqual([{ id: second.id, name: "Grey", url: at("plain"), attribution: second.attribution }]);
    // Removed, its address is free again.
    expect((await add({ name: "Harbour", url: at("credited") })).status).toBe(201);
    expect(asked).toHaveLength(3);
  });

  it("lists styles in the order they were added, even when added in the same instant", async () => {
    const { addLibraryStyle } = await import("./basemap-library");
    const context = authenticateSession(f.admin.secret, f.db)!;
    const instant = () => Date.parse("2026-10-01T00:00:00.000Z");
    const names = ["Zulu", "Alpha", "Mike", "Bravo"];
    for (const [n, name] of names.entries()) await addLibraryStyle(context, { name, url: `${at("plain")}&n=${n}` }, f.db, { now: instant });
    expect(((await configuration()).basemapStyles as { name: string }[]).map(added => added.name)).toEqual(names);
    expect(((await runtime()).basemapStyles as { name: string }[]).map(added => added.name)).toEqual(names);
  });

  it("refuses an unknown style and a malformed Offered, changing nothing", async () => {
    const added = await (await add({ name: "Harbour", url: at("credited") })).json();
    for (const response of [await offer("unknown", false), await remove("unknown")]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    for (const value of ["no", null, 0]) {
      const response = await offer(added.id, value);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Give offered as true or false, and nothing else." } });
    }
    expect((await configuration()).basemapStyles).toEqual([added]);
  });
});

describe("who may change the library", () => {
  it.each(["anonymous", "member", "member-token", "cross-origin-cookie"])("refuses %s, at the gate and the handler, sending and changing nothing", async mode => {
    const added = await (await add({ name: "Harbour", url: at("credited") })).json();
    const before = rows();
    const memberToken = () => createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    const headers: Record<string, string> = { "content-type": "application/json", ...(mode === "anonymous" ? { origin: ORIGIN }
      : mode === "member" ? { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN }
      : mode === "member-token" ? { authorization: `Bearer ${memberToken()}` }
      : { cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" }) };
    const status = mode === "anonymous" ? 401 : 403;
    const attempts = [
      () => call("POST", "/api/instance/basemaps", { name: "Grey", url: at("plain") }, headers),
      () => call("PATCH", `/api/instance/basemaps/${added.id}`, { offered: false }, headers),
      () => call("DELETE", `/api/instance/basemaps/${added.id}`, undefined, headers),
    ];
    const handlers = [(r: Request) => POST(r), (r: Request) => PATCH(r, params(added.id)), (r: Request) => DELETE(r, params(added.id))];
    for (const [index, attempt] of attempts.entries()) {
      for (const response of [gateRequest(attempt()), await handlers[index](attempt())]) {
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
      }
    }
    expect(rows()).toEqual(before);
    expect(asked).toHaveLength(1);
  });

  it("refuses an admin demoted between the request's admission and the write", async () => {
    const context = authenticateSession(f.admin.secret, f.db)!;
    const { addLibraryStyle } = await import("./basemap-library");
    const demote = () => f.db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run();
    await expect(addLibraryStyle(context, { name: "Harbour", url: at("credited") }, f.db, {
      inspect: async url => { demote(); return (await import("@/lib/net/inspect-style")).inspectStyle(url); },
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(rows()).toEqual([]);
  });
});

describe("the generated tools", () => {
  const tool = (name: string) => buildTools().find(candidate => candidate.name === name)!;
  const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const incoming = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(incoming.headers);
    headers.set("authorization", `Bearer ${secret}`);
    return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
  }) as typeof fetch;

  it("are confirmed writes on the library, never offered to the SQL and workflow assistants", () => {
    expect(tool("add_basemap_style")).toMatchObject({ path: "/api/instance/basemaps", method: "post", confirm: true,
      effects: { readOnly: false, writes: [{ resource: "basemaps", collection: true, result: "id" }] },
      mcp: { destructiveHint: false, openWorldHint: true, idempotentHint: false } });
    expect(tool("set_basemap_style_offered")).toMatchObject({ path: "/api/instance/basemaps/{id}", method: "patch", confirm: true,
      effects: { readOnly: false, writes: [{ resource: "basemaps", collection: true, argument: "id" }] },
      mcp: { destructiveHint: true, openWorldHint: false } });
    expect(tool("remove_basemap_style")).toMatchObject({ path: "/api/instance/basemaps/{id}", method: "delete", confirm: true,
      effects: { readOnly: false, writes: [{ resource: "basemaps", collection: true, argument: "id" }] },
      mcp: { destructiveHint: true, openWorldHint: false, idempotentHint: true } });
    for (const name of ["add_basemap_style", "set_basemap_style_offered", "remove_basemap_style"]) {
      expect(admittedTools("read_only")).not.toContain(tool(name));
      expect(admittedTools("full")).toContain(tool(name));
    }
    expect(tool("add_basemap_style").description).toContain("reads the address once");
    expect(tool("add_basemap_style").confirmation?.consequence).toContain("reads the style's address once");
  });

  it("add, hide and remove for an admin's token, and refuse a member's", async () => {
    const member = createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    const refusedAdd = await executeTool(tool("add_basemap_style"), { name: "Harbour", url: at("credited") }, ORIGIN, dispatch(member));
    expect(refusedAdd.status).toBe(403);
    expect(asked).toEqual([]);
    const added = await executeTool(tool("add_basemap_style"), { name: "Harbour", url: at("credited") }, ORIGIN, dispatch(f.token.secret));
    expect(added.status).toBe(201);
    const id = (added.body as { id: string }).id;
    expect(asked).toHaveLength(1);
    expect((await executeTool(tool("set_basemap_style_offered"), { id, offered: false }, ORIGIN, dispatch(member))).status).toBe(403);
    expect((await executeTool(tool("set_basemap_style_offered"), { id, offered: false }, ORIGIN, dispatch(f.token.secret))).body).toMatchObject({ id, offered: false });
    expect((await executeTool(tool("remove_basemap_style"), { id }, ORIGIN, dispatch(member))).status).toBe(403);
    expect((await executeTool(tool("remove_basemap_style"), { id }, ORIGIN, dispatch(f.token.secret))).body).toEqual({ removed: true });
    expect(rows()).toEqual([]);
  });

  const turn = async (context: Parameters<typeof runAssistant>[1]["context"]) => {
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "add-style", name: "add_basemap_style", args: { name: "Harbour chart", url: at("credited") } }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const sent: string[] = [];
    const deps = { scope: testAccountScope(f.db, "admin"), baseUrl: ORIGIN, pending,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const incoming = input instanceof Request ? input : new Request(String(input), init);
        sent.push(`${incoming.method} ${new URL(incoming.url).pathname}`);
        return dispatch(f.token.secret)(incoming);
      }) as typeof fetch };
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Add the harbour chart", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
    return { events, sent, pending, deps };
  };

  it("are refused to the SQL and workflow assistants before any request", async () => {
    for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
      const { events, sent } = await turn(context);
      expect(events.find(event => event.type === "tool_result")).toMatchObject({ tool: "add_basemap_style", ok: false, outcome: "refused",
        body: { error: { code: POLICY_REFUSAL_CODE } } });
      expect(sent.filter(request => request.includes("/api/instance/"))).toEqual([]);
    }
    expect(asked).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("are confirmed by the embedded assistant before the address is read", async () => {
    const { events, sent, pending, deps } = await turn(undefined);
    const question = events.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.confirmation).toMatchObject({ target: "Add Harbour chart to the basemap library?" });
    expect(sent.filter(request => request.includes("/api/instance/"))).toEqual([]);
    expect(asked).toEqual([]);

    const parked = pending.claim(deps.scope, question.id, "approved")!;
    const done: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, true, deps)) done.push(event);
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "add_basemap_style", ok: true }));
    expect(sent).toContain("POST /api/instance/basemaps");
    expect(asked).toHaveLength(1);
    expect(rows()).toEqual([expect.objectContaining({ name: "Harbour chart", url: at("credited"), offered: 1 })]);
  });
});
