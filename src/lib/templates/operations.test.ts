import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { GET as listRoute } from "@/app/api/templates/route";
import { POST as refreshRoute } from "@/app/api/templates/refresh/route";
import { GET as readRoute } from "@/app/api/templates/[id]/route";
import { GET as pictureRoute } from "@/app/api/templates/[id]/picture/route";
import { POST as testRoute } from "@/app/api/instance/services/[service]/test/route";
import { GET as configRoute } from "@/app/api/config/route";
import { admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { resumeAssistant, runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { testAccountScope } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { buildTemplate, writeShippedFolder, type BuiltTemplate } from "../../../test-support/templates/builder";
import { startLoopbackCatalogue, type LoopbackCatalogue } from "../../../test-support/templates/catalogue";
import { resetCatalogueForTests } from "./catalogue";
import { CATALOGUE_INDEX_FILE, TEMPLATE_PICTURE_MAX_BYTES } from "./format";
import * as shipped from "./shipped";

/**
 * The template operations: list, read one and refresh, each a generated
 * tool, the same by cookie, token and tool, for every signed-in account and
 * refused to an anonymous caller; the picture a route outside the tool set;
 * the catalogue's Test through the services' Test operation, admins only,
 * refused while the catalogue is off; the runtime read saying whether the
 * catalogue is in use; and the assistants: the SQL and workflow ones offered
 * list and read and refused the refresh, the embedded one asking before the
 * Test.
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
      .toEqual(["get_template", "list_templates", "refresh_templates"]);
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
