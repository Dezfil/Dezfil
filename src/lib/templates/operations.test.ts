import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { GET as listRoute } from "@/app/api/templates/route";
import { POST as refreshRoute } from "@/app/api/templates/refresh/route";
import { GET as readRoute } from "@/app/api/templates/[id]/route";
import { GET as pictureRoute } from "@/app/api/templates/[id]/picture/route";
import { POST as fetchRoute } from "@/app/api/templates/[id]/fetch/route";
import { POST as copyRoute } from "@/app/api/templates/[id]/copy/route";
import { POST as testRoute } from "@/app/api/instance/services/[service]/test/route";
import { GET as configRoute } from "@/app/api/config/route";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { resumeAssistant, runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
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
import { REFRESH_WINDOW_MS, refreshCatalogue, resetCatalogueForTests } from "./catalogue";
import { CATALOGUE_INDEX_FILE, TEMPLATE_PICTURE_MAX_BYTES } from "./format";
import { downloadedTemplatesDir } from "./installed";
import { INSTALL_REFUSAL_CODES, TEMPLATE_REFUSAL_CODES } from "./refusals";
import * as shipped from "./shipped-index";

/**
 * The template operations: list, read one, refresh and fetch, each a
 * generated tool, the same by cookie, token and tool, for every signed-in
 * account and refused to an anonymous caller; the picture a route outside
 * the tool set; the catalogue's Test through the services' Test operation,
 * admins only, refused while the catalogue is off; the runtime read saying
 * whether the catalogue is in use; and the assistants: the SQL and workflow
 * ones offered list and read and refused the refresh and the fetch, the
 * embedded one asking before the Test, a fetch and a copy, the version of
 * a fetch or a copy bound into the call it parks; and the copy's version:
 * the installed one, a listed one only once fetched.
 */

keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
let f: ReturnType<typeof instanceSettingsFixture>;
let catalogue: LoopbackCatalogue;
let dir: string;
let built: string;
let A1: BuiltTemplate, C1: BuiltTemplate;

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-ops-"));
  A1 = await buildTemplate(path.join(built, "a1"), { id: "harbour-stations", version: 1 });
  C1 = await buildTemplate(path.join(built, "c1"), { id: "quiet-park", version: 1, title: "Quiet park" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  resetQueryInstance();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-ops-run-"));
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
  await catalogue.close();
  resetCatalogueForTests();
  resetQueryInstance();
  f.close();
  resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

const memberCookie = () => ({ cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN });
const adminCookie = () => ({ cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN });
const adminToken = () => ({ authorization: `Bearer ${f.token.secret}` });
const memberToken = () => ({ authorization: `Bearer ${createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret}` });
const call = (method: string, route: string, headers: Record<string, string>) =>
  socketRequest(new Request(`${ORIGIN}${route}`, { method, headers }));
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const switchOff = () => writeStoredSettings({ "templates.catalogue": false }, f.db);

describe("by cookie and by token", () => {
  it("list, refresh, read one and the picture answer a member and an admin, private", async () => {
    const listed = await listRoute(call("GET", "/api/templates", memberCookie()));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    expect(await listed.json()).toMatchObject({ templates: [{ id: "quiet-park", origin: "shipped" }], catalogue: { state: "not_read" } });
    expect(catalogue.requests).toEqual([]);

    const refreshed = await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("cache-control")).toBe("private, no-store");
    const list = await refreshed.json();
    expect(list.templates.map((t: { id: string }) => t.id)).toEqual(["quiet-park", "harbour-stations"]);
    expect(list.catalogue).toMatchObject({ state: "listed", host: catalogue.origin });
    const byToken = await refreshRoute(call("POST", "/api/templates/refresh", memberToken()));
    expect(await byToken.json()).toEqual(list);
    expect(catalogue.requestsFor(`/${CATALOGUE_INDEX_FILE}`)).toHaveLength(1);

    const read = await readRoute(call("GET", "/api/templates/harbour-stations", adminToken()), params("harbour-stations"));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(await read.json()).toMatchObject({ id: "harbour-stations", present: false, howMade: A1.facts.howMade });

    for (const [theme, file] of [[null, "pictures/light.png"], ["dark", "pictures/dark.png"]] as const) {
      const route = `/api/templates/harbour-stations/picture${theme ? `?theme=${theme}` : ""}`;
      const picture = await pictureRoute(call("GET", route, memberCookie()), params("harbour-stations"));
      expect(picture.status).toBe(200);
      expect(picture.headers.get("content-type")).toBe("image/png");
      expect(picture.headers.get("cache-control")).toBe("private, max-age=300");
      expect(Buffer.from(await picture.arrayBuffer())).toEqual(A1.files.binaries.get(file));
    }
    const shippedPicture = await pictureRoute(call("GET", "/api/templates/quiet-park/picture?theme=dark", adminToken()), params("quiet-park"));
    expect(Buffer.from(await shippedPicture.arrayBuffer())).toEqual(C1.files.binaries.get("pictures/dark.png"));
  });

  it("refuses an anonymous request to each, at the gate and the handler, sending nothing", async () => {
    const attempts: [string, string, (r: Request) => Promise<Response>][] = [
      ["GET", "/api/templates", (r) => listRoute(r)],
      ["POST", "/api/templates/refresh", (r) => refreshRoute(r)],
      ["GET", "/api/templates/harbour-stations", (r) => readRoute(r, params("harbour-stations"))],
      ["GET", "/api/templates/harbour-stations/picture", (r) => pictureRoute(r, params("harbour-stations"))],
    ];
    for (const [method, route, handler] of attempts) {
      for (const response of [gateRequest(call(method, route, { origin: ORIGIN })), await handler(call(method, route, { origin: ORIGIN }))]) {
        expect(response.status, `${method} ${route}`).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toEqual({ error: { code: "authentication_required", message: expect.any(String) } });
      }
    }
    expect(catalogue.requests).toEqual([]);
  });

  it("refuses a cookie refresh from another origin, sending nothing", async () => {
    const response = await refreshRoute(call("POST", "/api/templates/refresh", { cookie: `dezfil_session=${f.member.secret}`, origin: "https://elsewhere.test" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    expect(catalogue.requests).toEqual([]);
  });

  it("answers an unknown id with template_not_listed, a picture not kept with not_found, and a theme it does not know with invalid_request", async () => {
    const unknown = await readRoute(call("GET", "/api/templates/no-such", memberCookie()), params("no-such"));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "template_not_listed", message: expect.any(String) } });
    expect((await pictureRoute(call("GET", "/api/templates/no-such/picture", memberCookie()), params("no-such"))).status).toBe(404);
    catalogue.serve("/pictures/harbour-stations-1-dark.png", Buffer.alloc(TEMPLATE_PICTURE_MAX_BYTES + 1), { type: "image/png" });
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    const missing = await pictureRoute(call("GET", "/api/templates/harbour-stations/picture", memberCookie()), params("harbour-stations"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");
    const theme = await pictureRoute(call("GET", "/api/templates/quiet-park/picture?theme=sepia", memberCookie()), params("quiet-park"));
    expect(theme.status).toBe(400);
    expect((await theme.json()).error.code).toBe("invalid_request");
  });

  it("with the catalogue off, refuses the refresh with its coded reason and sends nothing, listing the shipped ones", async () => {
    switchOff();
    const refused = await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    expect(refused.status).toBe(409);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(await refused.json()).toEqual({ error: { code: "templates_catalogue_off", message: expect.any(String) } });
    const listed = await (await listRoute(call("GET", "/api/templates", memberCookie()))).json();
    expect(listed).toMatchObject({ templates: [{ id: "quiet-park" }], catalogue: { state: "off" } });
    expect(catalogue.requests).toEqual([]);
  });
});

describe("the catalogue's Test", () => {
  it("passes for an admin by page and by tool, is refused to a member, and while off is refused sending nothing", async () => {
    const tested = await testRoute(call("POST", "/api/instance/services/templates/test", adminCookie()), { params: Promise.resolve({ service: "templates" }) });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toEqual({ service: "templates", result: "passed", templates: 1, milliseconds: expect.any(Number) });
    const member = await testRoute(call("POST", "/api/instance/services/templates/test", memberCookie()), { params: Promise.resolve({ service: "templates" }) });
    expect(member.status).toBe(403);
    const byTool = await executeTool(tool("test_service"), { service: "templates" }, ORIGIN, dispatch(f.token.secret));
    expect(byTool.body).toMatchObject({ service: "templates", result: "passed", templates: 1 });
    const sent = catalogue.requests.length;
    expect(sent).toBe(2);
    switchOff();
    const off = await testRoute(call("POST", "/api/instance/services/templates/test", adminCookie()), { params: Promise.resolve({ service: "templates" }) });
    expect(off.status).toBe(409);
    expect((await off.json()).error.code).toBe("templates_catalogue_off");
    expect(catalogue.requests).toHaveLength(sent);
  });
});

describe("the runtime read", () => {
  it("says whether the catalogue is in use", async () => {
    const read = async () => (await (await configRoute(call("GET", "/api/config", memberCookie()))).json()).templates;
    expect(await read()).toEqual({ catalogue: true });
    switchOff();
    expect(await read()).toEqual({ catalogue: false });
  });
});

const tool = (name: string) => buildTools().find((candidate) => candidate.name === name)!;
const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const incoming = input instanceof Request ? input : new Request(String(input), init);
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${secret}`);
  return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
}) as typeof fetch;

describe("the generated tools", () => {
  it("are list and read, local, and refresh, reaching outside; the picture is not a tool", () => {
    expect(tool("list_templates")).toMatchObject({ path: "/api/templates", method: "get", confirm: false,
      effects: { readOnly: true, writes: [] }, mcp: { destructiveHint: false, openWorldHint: false, idempotentHint: true } });
    expect(tool("get_template")).toMatchObject({ path: "/api/templates/{id}", method: "get", confirm: false,
      effects: { readOnly: true, writes: [] }, mcp: { destructiveHint: false, openWorldHint: false } });
    expect(tool("refresh_templates")).toMatchObject({ path: "/api/templates/refresh", method: "post", confirm: false,
      effects: { readOnly: true, writes: [], reachesOutside: true }, mcp: { destructiveHint: false, openWorldHint: true } });
    expect(tool("list_templates").effects.reachesOutside).toBeUndefined();
    expect(buildTools().filter((t) => t.path.startsWith("/api/templates")).map((t) => t.name).sort())
      .toEqual(["copy_template", "fetch_template", "get_template", "list_templates", "refresh_templates"]);
  });

  it("answer by a member's token as the routes do", async () => {
    const secret = memberToken().authorization.slice("Bearer ".length);
    const refreshed = await executeTool(tool("refresh_templates"), {}, ORIGIN, dispatch(secret));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ catalogue: { state: "listed" } });
    const listed = await executeTool(tool("list_templates"), {}, ORIGIN, dispatch(secret));
    expect(listed.body).toEqual(refreshed.body);
    const read = await executeTool(tool("get_template"), { id: "harbour-stations" }, ORIGIN, dispatch(secret));
    expect(read.body).toMatchObject({ id: "harbour-stations", howMade: A1.facts.howMade });
    const unknown = await executeTool(tool("get_template"), { id: "no-such" }, ORIGIN, dispatch(secret));
    expect(unknown.status).toBe(404);
    expect(catalogue.requestsFor(`/${CATALOGUE_INDEX_FILE}`)).toHaveLength(1);
  });
});

describe("the assistants", () => {
  const turn = async (call: { name: string; args: Record<string, unknown> }, context?: Parameters<typeof runAssistant>[1]["context"]) => {
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "call-1", name: call.name, args: call.args }] },
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
    for await (const event of runAssistant(provider, { message: "Templates", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
    return { events, sent, pending, deps };
  };
  const READ_ONLY_PAGES = [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const;

  it("the SQL and workflow assistants are offered list and read, and refused the refresh before any request", async () => {
    const offered = admittedTools("read_only").map((t) => t.name);
    expect(offered).toEqual(expect.arrayContaining(["list_templates", "get_template"]));
    expect(offered).not.toContain("refresh_templates");
    for (const context of READ_ONLY_PAGES) {
      const listed = await turn({ name: "list_templates", args: {} }, context);
      expect(listed.events.find((e) => e.type === "tool_result")).toMatchObject({ tool: "list_templates", ok: true });
      const { events, sent } = await turn({ name: "refresh_templates", args: {} }, context);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ tool: "refresh_templates", ok: false, outcome: "refused",
        body: { error: { code: POLICY_REFUSAL_CODE } } });
      expect(sent).toEqual([]);
    }
    expect(catalogue.requests).toEqual([]);
  });

  it("the embedded assistant refreshes without asking, and asks before testing the catalogue", async () => {
    const refreshed = await turn({ name: "refresh_templates", args: {} });
    expect(refreshed.events.some((e) => e.type === "confirm_required")).toBe(false);
    expect(refreshed.events.find((e) => e.type === "tool_result")).toMatchObject({ tool: "refresh_templates", ok: true });
    const sent = catalogue.requests.length;
    const { events, pending, deps } = await turn({ name: "test_service", args: { service: "templates" } });
    const question = events.find((e) => e.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.confirmation?.target).toContain("templates");
    expect(catalogue.requests).toHaveLength(sent);
    const parked = pending.claim(deps.scope, question.id, "approved")!;
    const done: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, true, deps)) done.push(event);
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "test_service", ok: true }));
    expect(catalogue.requests).toHaveLength(sent + 1);
  });
});

describe("fetch", () => {
  const fetchCall = (headers: Record<string, string>, body?: string, id = "harbour-stations") =>
    fetchRoute(socketRequest(new Request(`${ORIGIN}/api/templates/${id}/fetch`, {
      method: "POST", headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body,
    })), params(id));
  const archives = () => catalogue.requests.filter((r) => r.path.startsWith("/archives/"));
  const refreshPastWindow = (offset: number) => refreshCatalogue(f.db, { now: Date.now() + offset * (REFRESH_WINDOW_MS + 1) });

  it("is a generated tool that writes the templates, reaches outside and asks first, its words binding the version", () => {
    expect(tool("fetch_template")).toMatchObject({
      path: "/api/templates/{id}/fetch", method: "post", confirm: true,
      effects: { readOnly: false, writes: [{ resource: "templates", argument: "id", collection: true }] },
      mcp: { destructiveHint: false, openWorldHint: true, idempotentHint: false },
      confirmation: { subject: { path: "/api/templates/{id}", argument: "id", binds: { argument: "version", path: "version" } } },
    });
    expect(tool("fetch_template").effects.reachesOutside).toBeUndefined();
  });

  it("answers every refusal an install can give as a documented error code, and the index's own as none", () => {
    for (const code of INSTALL_REFUSAL_CODES) expect(ERROR_CATALOGUE, code).toHaveProperty(code);
    expect(INSTALL_REFUSAL_CODES).toHaveLength(TEMPLATE_REFUSAL_CODES.length - 4);
    for (const code of TEMPLATE_REFUSAL_CODES.filter((c) => !INSTALL_REFUSAL_CODES.includes(c as never))) {
      expect(ERROR_CATALOGUE, code).not.toHaveProperty(code);
    }
  });

  it("answers the same by cookie, token and tool: one download, then the version installed", async () => {
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    const byCookie = await fetchCall(memberCookie());
    expect(byCookie.status).toBe(200);
    expect(byCookie.headers.get("cache-control")).toBe("private, no-store");
    expect(await byCookie.json()).toEqual({ id: "harbour-stations", version: 1, size: A1.size, downloaded: true });
    const byToken = await fetchCall(memberToken(), JSON.stringify({ version: 1 }));
    expect(await byToken.json()).toEqual({ id: "harbour-stations", version: 1, size: A1.size, downloaded: false });
    const secret = memberToken().authorization.slice("Bearer ".length);
    const byTool = await executeTool(tool("fetch_template"), { id: "harbour-stations" }, ORIGIN, dispatch(secret));
    expect(byTool.body).toEqual({ id: "harbour-stations", version: 1, size: A1.size, downloaded: false });
    const shippedOne = await executeTool(tool("fetch_template"), { id: "quiet-park", version: 1 }, ORIGIN, dispatch(secret));
    expect(shippedOne.body).toEqual({ id: "quiet-park", version: 1, size: C1.size, downloaded: false });
    expect(archives()).toHaveLength(1);
  });

  it("refuses an anonymous request at the gate and the handler, and a cookie from another origin, sending nothing", async () => {
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    const sent = catalogue.requests.length;
    for (const response of [gateRequest(call("POST", "/api/templates/harbour-stations/fetch", { origin: ORIGIN })), await fetchCall({ origin: ORIGIN })]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "authentication_required", message: expect.any(String) } });
    }
    const elsewhere = await fetchCall({ cookie: `dezfil_session=${f.member.secret}`, origin: "https://elsewhere.test" });
    expect(elsewhere.status).toBe(403);
    expect(catalogue.requests).toHaveLength(sent);
  });

  it("refuses a body that is not a version, a body past its bound, and a version not listed, each coded and sending nothing", async () => {
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    const sent = catalogue.requests.length;
    for (const body of [JSON.stringify({ version: "1" }), JSON.stringify({ version: 0 }), JSON.stringify({ name: "x" }), "[1]", "{ not json"]) {
      const response = await fetchCall(memberCookie(), body);
      expect(response.status, body).toBe(400);
      expect((await response.json()).error.code, body).toBe("invalid_request");
    }
    const large = await fetchCall(memberCookie(), JSON.stringify({ version: 1, padding: "x".repeat(70_000) }));
    expect(large.status).toBe(413);
    expect((await large.json()).error.code).toBe("request_body_too_large");
    const unlisted = await fetchCall(memberCookie(), JSON.stringify({ version: 2 }));
    expect(unlisted.status).toBe(404);
    expect((await unlisted.json()).error.code).toBe("template_not_listed");
    expect(catalogue.requests).toHaveLength(sent);
  });

  it("answers a refused archive with its code and status, and while off the switch's reason, leaving nothing installed", async () => {
    await catalogue.publish([A1], { edit: (index) => { index.templates[0].sha256 = "0".repeat(64); } });
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    const mismatch = await fetchCall(memberCookie());
    expect(mismatch.status).toBe(422);
    expect(mismatch.headers.get("cache-control")).toBe("private, no-store");
    expect(await mismatch.json()).toEqual({ error: { code: "template_checksum_mismatch", message: expect.any(String) } });
    await catalogue.publish([A1], { edit: (index) => { index.templates[0].size = A1.size - 1; } });
    await refreshPastWindow(1);
    const large = await fetchCall(memberCookie());
    expect(large.status).toBe(413);
    expect((await large.json()).error.code).toBe("template_archive_too_large");
    switchOff();
    const sent = catalogue.requests.length;
    const off = await fetchCall(memberCookie());
    expect(off.status).toBe(409);
    expect((await off.json()).error.code).toBe("templates_catalogue_off");
    expect(catalogue.requests).toHaveLength(sent);
    expect(await import("node:fs/promises").then((fs) => fs.readdir(downloadedTemplatesDir()).catch(() => []))).toEqual([]);
  });

  describe("through the assistants", () => {
    const turn = async (calls: { name: string; args: Record<string, unknown> }, context?: Parameters<typeof runAssistant>[1]["context"]) => {
      const pending = new PendingActionStore();
      const provider = stubProvider([
        { text: "", toolCalls: [{ id: "call-1", name: calls.name, args: calls.args }] },
        { text: "Done.", toolCalls: [] },
      ]);
      const deps = { scope: testAccountScope(f.db, "member"), baseUrl: ORIGIN, pending,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const incoming = input instanceof Request ? input : new Request(String(input), init);
          return dispatch(memberToken().authorization.slice("Bearer ".length))(incoming);
        }) as typeof fetch };
      const events: AssistantEvent[] = [];
      for await (const event of runAssistant(provider, { message: "Fetch it", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
      return { events, pending, deps };
    };
    const resume = async (parked: ReturnType<PendingActionStore["claim"]>, deps: Awaited<ReturnType<typeof turn>>["deps"]) => {
      const done: AssistantEvent[] = [];
      for await (const event of resumeAssistant(parked!, true, deps)) done.push(event);
      return done;
    };
    const question = (events: AssistantEvent[]) => {
      const asked = events.find((e) => e.type === "confirm_required");
      if (asked?.type !== "confirm_required") throw new Error("expected a confirmation");
      return asked;
    };

    it("the SQL and workflow assistants refuse the fetch with the policy refusal before any request", async () => {
      expect(admittedTools("read_only").map((t) => t.name)).not.toContain("fetch_template");
      await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
      const sent = catalogue.requests.length;
      for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
        const { events } = await turn({ name: "fetch_template", args: { id: "harbour-stations" } }, context);
        expect(events.find((e) => e.type === "tool_result")).toMatchObject({ tool: "fetch_template", ok: false, outcome: "refused",
          body: { error: { code: POLICY_REFUSAL_CODE } } });
      }
      expect(catalogue.requests).toHaveLength(sent);
    });

    it("the embedded assistant asks first, naming the version and its size, binds that version into the call, and fetches it on approval", async () => {
      await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
      const { events, pending, deps } = await turn({ name: "fetch_template", args: { id: "harbour-stations" } });
      const asked = question(events);
      expect(asked.confirmation).toEqual({
        target: "Download version 1 of Harbour stations (harbour-stations)?",
        consequence: `Its archive, ${Math.round(A1.size / 1024)} KB, comes from the template catalogue and is checked whole before it is installed on this server. ` +
          "Nothing is downloaded if that version is installed already.",
      });
      expect(asked.args).toEqual({ id: "harbour-stations", version: 1 });
      expect(archives()).toEqual([]);
      const done = await resume(pending.claim(deps.scope, asked.id, "approved"), deps);
      expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "fetch_template", ok: true,
        body: { id: "harbour-stations", version: 1, size: A1.size, downloaded: true } }));
      expect(archives().map((r) => r.path)).toEqual(["/archives/harbour-stations-1.zip"]);
    });

    it("a confirmation pending across an index move acts on the version its words name, never the newer one", async () => {
      await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
      const { events, pending, deps } = await turn({ name: "fetch_template", args: { id: "harbour-stations" } });
      const asked = question(events);
      expect(asked.confirmation?.target).toBe("Download version 1 of Harbour stations (harbour-stations)?");
      const A2 = await buildTemplate(path.join(dir, "a2"), { id: "harbour-stations", version: 2 });
      await catalogue.publish([A2]);
      await refreshPastWindow(1);
      const done = await resume(pending.claim(deps.scope, asked.id, "approved"), deps);
      expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "fetch_template", ok: false,
        body: { error: { code: "template_not_listed", message: expect.any(String) } } }));
      expect(archives()).toEqual([]);
    });

    it("a call naming another version than the card's names that version, its size as the catalogue lists it", async () => {
      await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
      const { events } = await turn({ name: "fetch_template", args: { id: "harbour-stations", version: 2 } });
      const asked = question(events);
      expect(asked.confirmation).toEqual({
        target: "Download version 2 of Harbour stations (harbour-stations)?",
        consequence: "Its archive, of the size the catalogue lists, comes from the template catalogue and is checked whole before it is installed on this server. " +
          "Nothing is downloaded if that version is installed already.",
      });
      expect(asked.args).toEqual({ id: "harbour-stations", version: 2 });
    });

    it("a fetch whose template cannot be read is not asked, and the read's refusal ends the turn", async () => {
      const { events } = await turn({ name: "fetch_template", args: { id: "no-such" } });
      expect(events.some((e) => e.type === "confirm_required")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "template_not_listed" }));
      expect(catalogue.requests).toEqual([]);
    });
  });
});

describe("copy", () => {
  const copyCall = (headers: Record<string, string>, body?: string, id = "harbour-stations") =>
    copyRoute(socketRequest(new Request(`${ORIGIN}/api/templates/${id}/copy`, {
      method: "POST", headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body,
    })), params(id));
  const fetchCall = (version: number) =>
    fetchRoute(socketRequest(new Request(`${ORIGIN}/api/templates/harbour-stations/fetch`, {
      method: "POST", headers: { ...memberCookie(), "content-type": "application/json" }, body: JSON.stringify({ version }),
    })), params("harbour-stations"));
  const refreshPastWindow = (offset: number) => refreshCatalogue(f.db, { now: Date.now() + offset * (REFRESH_WINDOW_MS + 1) });
  const projects = () => (f.db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  const copiedVersion = async (response: Response) => {
    expect(response.status).toBe(201);
    return ((await response.json()) as { members: { tables: { sourceParams: { version: number } }[] } }).members.tables[0].sourceParams.version;
  };
  /** Version 1 installed, version 2 listed. */
  const newerListed = async () => {
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    expect((await fetchCall(1)).status).toBe(200);
    await catalogue.publish([await buildTemplate(path.join(dir, "a2"), { id: "harbour-stations", version: 2 })]);
    await refreshPastWindow(1);
  };

  it("is a generated tool that writes the project and what it holds, local, and asks first, its words binding the installed version", () => {
    expect(tool("copy_template")).toMatchObject({
      path: "/api/templates/{id}/copy", method: "post", confirm: true,
      effects: { readOnly: false, writes: [
        { resource: "projects", result: "project.id", collection: true },
        { resource: "maps", result: "members.maps.*.id", collection: true },
        { resource: "layers", collection: true },
        { resource: "tables", result: "members.tables.*.id", collection: true },
      ] },
      mcp: { destructiveHint: false, openWorldHint: false, idempotentHint: false },
      confirmation: { subject: { path: "/api/templates/{id}", argument: "id",
        binds: { argument: "version", path: "installed", absent: "template_not_installed" } } },
    });
    expect(tool("copy_template").effects.reachesOutside).toBeUndefined();
    expect(tool("copy_template").description).toContain("belong to the authenticated account");
  });

  it("refuses a listed version not installed yet, naming the fetch, with nothing created and nothing sent; fetched, copies it", async () => {
    await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
    const sent = catalogue.requests.length;
    for (const body of [undefined, JSON.stringify({ version: 1 })]) {
      const refused = await copyCall(memberCookie(), body);
      expect(refused.status).toBe(409);
      expect(refused.headers.get("cache-control")).toBe("private, no-store");
      expect((await refused.json()).error).toEqual({ code: "template_not_installed",
        message: expect.stringContaining("POST /api/templates/harbour-stations/fetch") });
    }
    expect(catalogue.requests).toHaveLength(sent);
    expect(projects()).toBe(0);
    expect((await fetchCall(1)).status).toBe(200);
    expect(await copiedVersion(await copyCall(memberCookie()))).toBe(1);
  });

  it("acts on the version named alone, on the installed one without one, whether still listed or not", async () => {
    await newerListed();
    expect(await copiedVersion(await copyCall(memberCookie()))).toBe(1);
    expect(await copiedVersion(await copyCall(memberCookie(), JSON.stringify({ version: 1 })))).toBe(1);
    const newer = await copyCall(memberCookie(), JSON.stringify({ version: 2 }));
    expect(newer.status).toBe(409);
    expect((await newer.json()).error.code).toBe("template_not_installed");
    const unlisted = await copyCall(memberCookie(), JSON.stringify({ version: 3 }));
    expect(unlisted.status).toBe(404);
    expect((await unlisted.json()).error.code).toBe("template_not_listed");
    await catalogue.publish([]);
    await refreshPastWindow(2);
    expect(await copiedVersion(await copyCall(memberCookie(), JSON.stringify({ version: 1 })))).toBe(1);
    switchOff();
    expect(await copiedVersion(await copyCall(memberCookie()))).toBe(1);
    const off = await copyCall(memberCookie(), JSON.stringify({ version: 2 }));
    expect(off.status).toBe(409);
    expect((await off.json()).error.code).toBe("templates_catalogue_off");
  });

  describe("through the assistants", () => {
    const turn = async (calls: { name: string; args: Record<string, unknown> }, context?: Parameters<typeof runAssistant>[1]["context"]) => {
      const pending = new PendingActionStore();
      const provider = stubProvider([
        { text: "", toolCalls: [{ id: "call-1", name: calls.name, args: calls.args }] },
        { text: "Done.", toolCalls: [] },
      ]);
      const deps = { scope: testAccountScope(f.db, "member"), baseUrl: ORIGIN, pending,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const incoming = input instanceof Request ? input : new Request(String(input), init);
          return dispatch(memberToken().authorization.slice("Bearer ".length))(incoming);
        }) as typeof fetch };
      const events: AssistantEvent[] = [];
      for await (const event of runAssistant(provider, { message: "Copy it", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
      return { events, pending, deps };
    };
    const resume = async (parked: ReturnType<PendingActionStore["claim"]>, deps: Awaited<ReturnType<typeof turn>>["deps"]) => {
      const done: AssistantEvent[] = [];
      for await (const event of resumeAssistant(parked!, true, deps)) done.push(event);
      return done;
    };
    const question = (events: AssistantEvent[]) => {
      const asked = events.find((e) => e.type === "confirm_required");
      if (asked?.type !== "confirm_required") throw new Error("expected a confirmation");
      return asked;
    };
    const copiedBy = (done: AssistantEvent[]) => {
      const result = done.find((e) => e.type === "tool_result" && e.tool === "copy_template");
      if (result?.type !== "tool_result") throw new Error("expected the copy's result");
      return result;
    };

    it("the SQL and workflow assistants refuse the copy with the policy refusal, creating nothing", async () => {
      expect(admittedTools("read_only").map((t) => t.name)).not.toContain("copy_template");
      for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
        const { events } = await turn({ name: "copy_template", args: { id: "quiet-park" } }, context);
        expect(events.find((e) => e.type === "tool_result")).toMatchObject({ tool: "copy_template", ok: false, outcome: "refused",
          body: { error: { code: POLICY_REFUSAL_CODE } } });
      }
      expect(projects()).toBe(0);
    });

    it("the embedded assistant asks first, naming the installed version and its size, binds that version into the call, and copies it on approval", async () => {
      const { events, pending, deps } = await turn({ name: "copy_template", args: { id: "quiet-park" } });
      const asked = question(events);
      expect(asked.confirmation).toEqual({
        target: "Copy version 1 of Quiet park (quiet-park) into a new project?",
        consequence: `Its map, its workflow if it has one, and its datasets (an archive of ${Math.round(C1.size / 1024)} KB) become yours in a new project; ` +
          "the template stays as it is.",
      });
      expect(asked.args).toEqual({ id: "quiet-park", version: 1 });
      expect(projects()).toBe(0);
      const done = await resume(pending.claim(deps.scope, asked.id, "approved"), deps);
      expect(copiedBy(done)).toMatchObject({ ok: true, body: { project: { name: "Quiet park" } } });
      expect(projects()).toBe(1);
    });

    it("a confirmation pending across an index move acts on the version its words name, never the newer one", async () => {
      await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
      expect((await fetchCall(1)).status).toBe(200);
      const { events, pending, deps } = await turn({ name: "copy_template", args: { id: "harbour-stations" } });
      const asked = question(events);
      expect(asked.confirmation?.target).toBe("Copy version 1 of Harbour stations (harbour-stations) into a new project?");
      // The index moves to version 2, and version 2 is installed too: a
      // copy naming no version would now read it.
      await catalogue.publish([await buildTemplate(path.join(dir, "a2"), { id: "harbour-stations", version: 2 })]);
      await refreshPastWindow(1);
      expect((await fetchCall(2)).status).toBe(200);
      const done = await resume(pending.claim(deps.scope, asked.id, "approved"), deps);
      const result = copiedBy(done);
      expect(result.ok).toBe(true);
      expect((result.body as { members: { tables: { sourceParams: unknown }[] } }).members.tables[0].sourceParams)
        .toEqual({ template: "harbour-stations", version: 1 });
    });

    it("words a size only for the version the card describes", async () => {
      await newerListed();
      const { events } = await turn({ name: "copy_template", args: { id: "harbour-stations" } });
      const asked = question(events);
      expect(asked.args).toEqual({ id: "harbour-stations", version: 1 });
      expect(asked.confirmation?.consequence).toBe("Its map, its workflow if it has one, and its datasets (an archive of the size the template lists) " +
        "become yours in a new project; the template stays as it is.");
    });

    it("a copy with nothing installed is not asked, and the turn ends with the refusal naming the fetch", async () => {
      await refreshRoute(call("POST", "/api/templates/refresh", memberCookie()));
      const { events } = await turn({ name: "copy_template", args: { id: "harbour-stations" } });
      expect(events.some((e) => e.type === "confirm_required")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "template_not_installed" }));
      expect(projects()).toBe(0);
    });
  });
});
