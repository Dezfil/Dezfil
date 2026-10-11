import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DELETE as removeRoute } from "@/app/api/templates/downloads/route";
import { admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { resumeAssistant, runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { gateRequest } from "@/lib/auth/gate";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountScope } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import { startLoopbackCatalogue, type LoopbackCatalogue } from "../../../test-support/templates/catalogue";
import * as artifacts from "./artifacts";
import { REFRESH_WINDOW_MS, refreshCatalogue, resetCatalogueForTests } from "./catalogue";
import { setCopySeamForTests } from "./copy";
import { setDownloadSeamForTests } from "./download";
import * as shipped from "./shipped-index";

/**
 * Remove all: every downloaded template goes, and nothing else. An admin's
 * call, the same by cookie, token and generated tool, refused to a member
 * and to an anonymous caller; the embedded assistant asks first, its words
 * naming the size the downloads take, and the SQL and workflow assistants
 * refuse it. The shipped set, every copy and the engine's copies of
 * shipped data stay byte for byte; the removed templates' cards stay
 * listed while the catalogue lists them and are gone with it off. It
 * retires each version after the readers already under way: a copy held
 * mid-way finishes whole while nothing begun after finds the version, and
 * a download that lands while it waits its turn stays.
 */

keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
let f: ReturnType<typeof instanceSettingsFixture>;
let catalogue: LoopbackCatalogue;
let dir: string;
let built: string;
let A1: BuiltTemplate, A2: BuiltTemplate, C1: BuiltTemplate, W1: BuiltTemplate;
/** Releases a test's held seam, so a test that fails holding one leaves no
 * copy or download waiting for the next. */
let release: (() => void) | null = null;

// Ids written out, so a change in their form fails here.
const A_MAP = "template.harbour-stations.1.map";
const A_STATIONS = "template.harbour-stations.1.layer.layer-stations";
const C_MAP = "template.quiet-park.1.map";
const C_STATIONS = "template.quiet-park.1.layer.layer-stations";
const W_RINGS = "template.busy-stations.1.layer.layer-rings";

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-remove-"));
  A1 = await buildTemplate(path.join(built, "a1"), { id: "harbour-stations", version: 1 });
  A2 = await buildTemplate(path.join(built, "a2"), { id: "harbour-stations", version: 2 });
  C1 = await buildTemplate(path.join(built, "c1"), { id: "quiet-park", version: 1, title: "Quiet park" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-remove-run-"));
  vi.spyOn(shipped, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [C1]));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "localhost,127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32));
  resetSecretKeyCache();
  resetCatalogueForTests();
  catalogue = await startLoopbackCatalogue();
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", catalogue.indexUrl);
  await catalogue.publish([A1]);
});
afterEach(async () => {
  release?.();
  release = null;
  vi.restoreAllMocks();
  setCopySeamForTests(null);
  setDownloadSeamForTests(null);
  await catalogue.close();
  resetCatalogueForTests();
  resetQueryInstance();
  f.close();
  resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

type Headers = Record<string, string>;
const memberCookie = (): Headers => ({ cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN });
const adminCookie = (): Headers => ({ cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN });
const adminToken = (): Headers => ({ authorization: `Bearer ${f.token.secret}` });
const memberToken = (): Headers => ({ authorization: `Bearer ${createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret}` });

async function call(method: string, route: string, headers: Headers, body?: unknown) {
  const response = await dispatchAssistantTestRoute(socketRequest(new Request(`${ORIGIN}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })));
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : null;
  return { status: response.status, cache: response.headers.get("cache-control"), body: json as Record<string, unknown> | null };
}
const remove = (headers: Headers, query = "") => call("DELETE", `/api/templates/downloads${query}`, headers);
const tool = (name: string) => buildTools().find((candidate) => candidate.name === name)!;
const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${secret}`);
  return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
}) as typeof fetch;
const switchOff = () => writeStoredSettings({ "templates.catalogue": false }, f.db);

const downloads = () => path.join(dataDir(), "templates");
const versionFolder = (id: string, version: number) => path.join(downloads(), id, String(version));

/** Every file under a folder, by its path there, with its SHA-256. */
async function hashed(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  return out;
}

/** The bytes every file under a folder takes, read here by the test. */
async function bytesOf(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) total += (await readFile(path.join(entry.parentPath, entry.name))).length;
  }
  return total;
}

/** The artifact names the engine reads a built template's data through. */
const copiesOf = (t: BuiltTemplate) => [...t.files.binaries]
  .filter(([name]) => name.endsWith(".parquet"))
  .map(([, bytes]) => `template-${createHash("sha256").update(bytes).digest("hex")}.parquet`);

/** The copies people made: their rows and their datasets' files, hashed. */
async function copiesState() {
  const rows = (sql: string) => JSON.stringify(f.db.prepare(sql).all());
  const tables = f.db.prepare("SELECT file FROM data_tables WHERE source = 'template' ORDER BY file").all() as { file: string }[];
  const files = await Promise.all(tables.map(async ({ file }) => [file, createHash("sha256").update(await readFile(path.join(dataDir(), file))).digest("hex")]));
  return {
    projects: rows("SELECT * FROM projects ORDER BY id"),
    maps: rows("SELECT * FROM maps ORDER BY id"),
    layers: rows("SELECT * FROM layers ORDER BY id"),
    tables: rows("SELECT * FROM data_tables ORDER BY id"),
    files,
  };
}

async function refreshed() {
  expect((await call("POST", "/api/templates/refresh", memberCookie())).status).toBe(200);
}
async function fetched(id: string, version: number) {
  const answer = await call("POST", `/api/templates/${id}/fetch`, memberCookie(), { version });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

describe("a version number past nine digits", () => {
  it("admitted at install, is listed as installed, opens by its ids, copies, and Remove all removes it", async () => {
    const VERSION = 2026101101;
    const dated = await buildTemplate(path.join(dir, "dated"), { id: "dated-stations", version: VERSION });
    await catalogue.publish([A1, dated]);
    await refreshed();
    await fetched("dated-stations", VERSION);

    const read = await call("GET", "/api/templates", memberCookie());
    const card = (read.body!.templates as { id: string; installed: number | null; present: boolean }[]).find((t) => t.id === "dated-stations");
    expect(card).toMatchObject({ installed: VERSION, present: true });
    expect(read.body!.downloads).toMatchObject({ versions: 1 });

    const mapId = `template.dated-stations.${VERSION}.map`;
    const map = await call("GET", `/api/maps/${mapId}`, memberCookie());
    expect(map.status, JSON.stringify(map.body)).toBe(200);
    expect(map.body).toMatchObject({ id: mapId });
    const render = await call("GET", `/api/layers/template.dated-stations.${VERSION}.layer.layer-stations/render`, memberCookie());
    expect(render.body).toMatchObject({ ok: true, featureCount: 6 });

    // Without a version named, the copy finds the installed one itself.
    const copied = await call("POST", "/api/templates/dated-stations/copy", memberCookie());
    expect(copied.status, JSON.stringify(copied.body)).toBe(201);
    expect((copied.body!.members as { tables: { sourceParams: unknown }[] }).tables[0].sourceParams).toEqual({ template: "dated-stations", version: VERSION });

    const removed = await remove(adminCookie());
    expect(removed.body).toMatchObject({ versions: 1 });
    expect(existsSync(versionFolder("dated-stations", VERSION))).toBe(false);
    expect(await readdir(downloads()).catch(() => [])).toEqual([]);
  });
});

describe("the operation", () => {
  it("is a generated tool that removes this server's templates, local and destructive, and asks first, its words reading the size", () => {
    expect(tool("remove_template_downloads")).toMatchObject({
      path: "/api/templates/downloads", method: "delete", confirm: true,
      effects: { readOnly: false, writes: [{ resource: "templates", collection: true }] },
      mcp: { destructiveHint: true, openWorldHint: false, idempotentHint: true },
      confirmation: { subject: { path: "/api/templates", facts: { size: { path: "downloads.bytes", bytes: true } } } },
    });
    expect(tool("remove_template_downloads").effects.reachesOutside).toBeUndefined();
  });

  it("answers an admin the same by cookie, token and tool, removing what was downloaded, then nothing", async () => {
    await refreshed();
    await fetched("harbour-stations", 1);
    const bytes = await bytesOf(versionFolder("harbour-stations", 1));
    expect(bytes).toBeGreaterThan(0);
    expect((await call("GET", "/api/templates", memberCookie())).body!.downloads).toEqual({ versions: 1, bytes });

    const byCookie = await remove(adminCookie());
    expect(byCookie.status).toBe(200);
    expect(byCookie.cache).toBe("private, no-store");
    expect(byCookie.body).toEqual({ versions: 1, bytes });
    expect(existsSync(versionFolder("harbour-stations", 1))).toBe(false);
    expect((await call("GET", "/api/templates", memberCookie())).body!.downloads).toEqual({ versions: 0, bytes: 0 });

    const byToken = await remove(adminToken());
    expect(byToken.body).toEqual({ versions: 0, bytes: 0 });
    await fetched("harbour-stations", 1);
    const byTool = await executeTool(tool("remove_template_downloads"), {}, ORIGIN, dispatch(f.token.secret));
    expect(byTool.status).toBe(200);
    expect(byTool.body).toEqual({ versions: 1, bytes });
    // Nothing was sent: the one archive request is each fetch's.
    expect(catalogue.requests.filter((r) => r.path.startsWith("/archives/"))).toHaveLength(2);
  });

  it("refuses a member, an anonymous caller, a cookie from another origin and a parameter, removing nothing", async () => {
    await refreshed();
    await fetched("harbour-stations", 1);
    const before = await hashed(downloads());
    for (const [headers, status, code] of [
      [memberCookie(), 403, "forbidden"],
      [memberToken(), 403, "forbidden"],
      [{ cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" }, 403, "forbidden"],
    ] as const) {
      const answer = await remove(headers);
      expect(answer.status, JSON.stringify(headers)).toBe(status);
      expect(answer.cache).toBe("private, no-store");
      expect(answer.body).toEqual({ error: { code, message: expect.any(String) } });
    }
    const anonymous = () => socketRequest(new Request(`${ORIGIN}/api/templates/downloads`, { method: "DELETE", headers: { origin: ORIGIN } }));
    for (const response of [gateRequest(anonymous()), await removeRoute(anonymous())]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: "authentication_required", message: expect.any(String) } });
    }
    const byTool = await executeTool(tool("remove_template_downloads"), {}, ORIGIN, dispatch(memberToken().authorization.slice("Bearer ".length)));
    expect(byTool.status).toBe(403);
    const parameter = await remove(adminCookie(), "?id=harbour-stations");
    expect(parameter.status).toBe(400);
    expect(parameter.body).toMatchObject({ error: { code: "invalid_request" } });
    expect(await hashed(downloads())).toEqual(before);
  });
});

describe("what goes and what stays", () => {
  it("removes the downloads alone: the shipped set, every copy and the copies of shipped data stay; the cards stay listed with the catalogue on and go with it off", async () => {
    await catalogue.publish([A1, W1]);
    await refreshed();
    await fetched("harbour-stations", 1);
    await fetched("busy-stations", 1);
    // Open all three, so the engine holds copies of their data, and copy all three.
    for (const layer of [C_STATIONS, A_STATIONS, W_RINGS]) {
      const render = await call("GET", `/api/layers/${layer}/render`, memberCookie());
      expect(render.body, layer).toMatchObject({ ok: true });
    }
    for (const id of ["quiet-park", "harbour-stations", "busy-stations"]) {
      expect((await call("POST", `/api/templates/${id}/copy`, memberCookie())).status, id).toBe(201);
    }
    const tables = path.join(dataDir(), "tables");
    const staged = (await readdir(tables)).filter((name) => name.startsWith("template-")).sort();
    expect(staged).toEqual([...new Set([...copiesOf(C1), ...copiesOf(A1), ...copiesOf(W1)])].sort());
    // The workflow's bundled results are data no shipped template holds.
    const downloadsAlone = copiesOf(W1).filter((name) => !copiesOf(C1).includes(name));
    expect(downloadsAlone).toHaveLength(2);
    const shippedBefore = await hashed(shipped.shippedTemplatesDir());
    const shippedCopies = Object.fromEntries(await Promise.all(copiesOf(C1).map(async (name) =>
      [name, createHash("sha256").update(await readFile(path.join(tables, name))).digest("hex")])));
    const copiesBefore = await copiesState();
    const bytes = await bytesOf(versionFolder("harbour-stations", 1)) + await bytesOf(versionFolder("busy-stations", 1));

    expect((await remove(adminCookie())).body).toEqual({ versions: 2, bytes });

    expect(await readdir(downloads()).catch(() => [])).toEqual([]);
    // The engine's copies only the downloads needed are gone; the shipped one's stay, byte for byte.
    const left = (await readdir(tables)).filter((name) => name.startsWith("template-")).sort();
    expect(left).toEqual([...copiesOf(C1)].sort());
    for (const name of downloadsAlone) expect(left).not.toContain(name);
    for (const [name, sha] of Object.entries(shippedCopies)) {
      expect(createHash("sha256").update(await readFile(path.join(tables, name))).digest("hex")).toBe(sha);
    }
    expect(await hashed(shipped.shippedTemplatesDir())).toEqual(shippedBefore);
    expect(await copiesState()).toEqual(copiesBefore);
    // The copied maps still draw, from their own datasets.
    const copiedMaps = f.db.prepare("SELECT id FROM maps").all() as { id: string }[];
    expect(copiedMaps).toHaveLength(3);
    for (const map of copiedMaps) {
      const layers = (await call("GET", `/api/maps/${map.id}`, memberCookie())).body!.layers as { id: string }[];
      for (const layer of layers) expect((await call("GET", `/api/layers/${layer.id}/render`, memberCookie())).body, layer.id).toMatchObject({ ok: true });
    }
    // The shipped one still opens; a removed one is not found, and its copy asks for a fetch.
    expect((await call("GET", `/api/maps/${C_MAP}`, memberCookie())).status).toBe(200);
    expect((await call("GET", `/api/maps/${A_MAP}`, memberCookie())).status).toBe(404);
    expect((await call("GET", `/api/layers/${W_RINGS}/render`, memberCookie())).status).toBe(404);
    expect((await call("POST", "/api/templates/harbour-stations/copy", memberCookie())).body).toMatchObject({ error: { code: "template_not_installed" } });

    // Their cards stay while the catalogue lists them, absent now, and go with the catalogue off.
    const on = (await call("GET", "/api/templates", memberCookie())).body!;
    expect(on.templates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "quiet-park", origin: "shipped", installed: 1, present: true }),
      expect.objectContaining({ id: "harbour-stations", origin: "catalogue", installed: null, listed: 1, present: false, size: A1.size }),
      expect.objectContaining({ id: "busy-stations", origin: "catalogue", installed: null, listed: 1, present: false, size: W1.size }),
    ]));
    expect(on.templates).toHaveLength(3);
    expect(on.downloads).toEqual({ versions: 0, bytes: 0 });
    switchOff();
    const off = (await call("GET", "/api/templates", memberCookie())).body!;
    expect((off.templates as { id: string }[]).map((t) => t.id)).toEqual(["quiet-park"]);
  });

  it("removes every version of a template, and the template's folder with them", async () => {
    await refreshed();
    await fetched("harbour-stations", 1);
    await catalogue.publish([A2]);
    await refreshCatalogue(f.db, { now: Date.now() + REFRESH_WINDOW_MS + 1 });
    await fetched("harbour-stations", 2);
    const bytes = await bytesOf(versionFolder("harbour-stations", 1)) + await bytesOf(versionFolder("harbour-stations", 2));
    expect((await remove(adminToken())).body).toEqual({ versions: 2, bytes });
    expect(existsSync(path.join(downloads(), "harbour-stations"))).toBe(false);
  });
});

describe("after its readers", () => {
  it("lets a copy held mid-way finish whole, while no open or copy begun after finds the version", async () => {
    await refreshed();
    await fetched("harbour-stations", 1);
    const folder = versionFolder("harbour-stations", 1);
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    release = held.resolve;
    setCopySeamForTests({ async beforeTransaction(key) {
      if (key !== "harbour-stations@1") return;
      entered.resolve();
      await held.promise;
    } });
    const copying = call("POST", "/api/templates/harbour-stations/copy", memberCookie());
    await entered.promise;
    let removed = false;
    const removing = remove(adminCookie()).finally(() => { removed = true; });
    // The version's record goes first: nothing begun from here on finds it.
    for (let i = 0; i < 200 && existsSync(path.join(folder, "record.json")); i += 1) await sleep(10);
    expect(existsSync(path.join(folder, "record.json"))).toBe(false);
    expect((await call("GET", `/api/maps/${A_MAP}`, memberCookie())).status).toBe(404);
    expect((await call("GET", `/api/layers/${A_STATIONS}/render`, memberCookie())).status).toBe(404);
    expect((await call("POST", "/api/templates/harbour-stations/copy", memberCookie())).body).toMatchObject({ error: { code: "template_not_installed" } });
    // The copy in flight holds the removal: its files are all still there.
    await sleep(300);
    expect(removed).toBe(false);
    expect(existsSync(path.join(folder, "datasets", "stations.parquet"))).toBe(true);
    held.resolve();
    const copy = await copying;
    expect(copy.status).toBe(201);
    expect((await removing).body).toMatchObject({ versions: 1 });
    expect(existsSync(folder)).toBe(false);
    // The copy is whole and draws from its own data.
    const mapId = ((copy.body!.members as { maps: { id: string }[] }).maps[0]).id;
    const layers = (await call("GET", `/api/maps/${mapId}`, memberCookie())).body!.layers as { id: string }[];
    expect(layers).toHaveLength(2);
    for (const layer of layers) expect((await call("GET", `/api/layers/${layer.id}/render`, memberCookie())).body).toMatchObject({ ok: true });
  });

  it("leaves a download that lands while it waits its turn, and two at once take each version once", async () => {
    await refreshed();
    await fetched("harbour-stations", 1);
    const bytes = await bytesOf(versionFolder("harbour-stations", 1));
    await catalogue.publish([A2]);
    await refreshCatalogue(f.db, { now: Date.now() + REFRESH_WINDOW_MS + 1 });
    const turn = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    release = held.resolve;
    setDownloadSeamForTests({ async transfer(key) {
      if (key !== "harbour-stations@2") return;
      turn.resolve();
      await held.promise;
    } });
    const downloading = call("POST", "/api/templates/harbour-stations/fetch", memberCookie(), { version: 2 });
    await turn.promise;
    // Two Remove alls see what is there now, then wait for the download's turn to end.
    const seen = vi.spyOn(artifacts, "downloadedFolders");
    const removing = [remove(adminCookie()), remove(adminToken())];
    for (let i = 0; i < 50 && seen.mock.results.length < 2; i += 1) await sleep(10);
    await Promise.all(seen.mock.results.map((result) => result.value));
    held.resolve();
    expect((await downloading).body).toMatchObject({ version: 2, downloaded: true });
    const answers = (await Promise.all(removing)).map((answer) => answer.body);
    expect(answers).toEqual(expect.arrayContaining([{ versions: 1, bytes }, { versions: 0, bytes: 0 }]));
    expect(existsSync(versionFolder("harbour-stations", 1))).toBe(false);
    expect(existsSync(path.join(versionFolder("harbour-stations", 2), "record.json"))).toBe(true);
    expect((await call("GET", "/api/maps/template.harbour-stations.2.map", memberCookie())).status).toBe(200);
  });
});

describe("through the assistants", () => {
  const turn = async (context?: Parameters<typeof runAssistant>[1]["context"]) => {
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "call-1", name: "remove_template_downloads", args: {} }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const deps = { scope: testAccountScope(f.db, "admin"), baseUrl: ORIGIN, pending, fetchImpl: dispatch(f.token.secret) };
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Remove them", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
    return { events, pending, deps };
  };

  it("the SQL and workflow assistants refuse it with the policy refusal, removing nothing", async () => {
    expect(admittedTools("read_only").map((t) => t.name)).not.toContain("remove_template_downloads");
    await refreshed();
    await fetched("harbour-stations", 1);
    const before = await hashed(downloads());
    for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
      const { events } = await turn(context);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ tool: "remove_template_downloads", ok: false, outcome: "refused",
        body: { error: { code: POLICY_REFUSAL_CODE } } });
    }
    expect(await hashed(downloads())).toEqual(before);
  });

  it("the embedded assistant asks first, naming the size the downloads take, and removes them on approval", async () => {
    await refreshed();
    await fetched("harbour-stations", 1);
    const bytes = await bytesOf(versionFolder("harbour-stations", 1));
    const { events, pending, deps } = await turn();
    const asked = events.find((e) => e.type === "confirm_required");
    if (asked?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(asked.confirmation).toEqual({
      target: "Remove every downloaded template from this server?",
      consequence: `The downloads take ${Math.round(bytes / 1024)} KB. Shipped templates and the copies people made stay as they are, and a removed ` +
        "template downloads again at its next open.",
    });
    expect(existsSync(versionFolder("harbour-stations", 1))).toBe(true);
    const done: AssistantEvent[] = [];
    for await (const event of resumeAssistant(pending.claim(deps.scope, asked.id, "approved")!, true, deps)) done.push(event);
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "remove_template_downloads", ok: true, body: { versions: 1, bytes } }));
    expect(existsSync(versionFolder("harbour-stations", 1))).toBe(false);
  });
});
