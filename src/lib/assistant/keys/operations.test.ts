import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { gateRequest } from "@/lib/auth/gate";
import { SESSION_COOKIE } from "@/lib/auth/http";
import { getAccount } from "@/lib/metadata/accounts";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountScope } from "@/lib/test-support/accounts";
import { buildTools } from "@/lib/tools/tools";
import { assistantRuns } from "../runs";
import { pendingActions } from "../pending";
import { dispatchAssistantTestRoute } from "../testing/route-dispatch";
import { socketRequest } from "../testing/socket-request";
import { setOwnKey } from "./change";
import { assistantKeyFacts, readAssistantKey } from "./store";

/** The three operations through the real route, as a person, an admin and a client. */

const origin = "http://127.0.0.1:3219";
const URL_PATH = "/api/account/assistant-key";
const KEY = "operations-key-value-abcd", OTHER = "operations-key-other-wxyz";
let dir: string;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-key-operations-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3219");
  closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache(); assistantRuns.resetForTests(); pendingActions.resetForTests();
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function person(id: string, admin = false) {
  const db = metadataDb();
  testAccountScope(db, id);
  if (admin) db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(id);
  const session = issueSession(getAccount(id, db)!, db, Date.now());
  const token = createApiToken(authenticateSession(session.secret, db)!, "Route fixture", db).secret;
  const call = (url: string, init: RequestInit = {}) => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }));
  return Object.assign(call, { cookie: `${SESSION_COOKIE}=${session.secret}` });
}
const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("saves, reads, replaces and removes, and removing twice is harmless", async () => {
  const ada = person("ada");
  expect(await (await ada(URL_PATH)).json()).toEqual({ key: null, unreadable: false });

  const saved = await ada(URL_PATH, put({ provider: "anthropic", key: `  ${KEY}\n` }));
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toContain("no-store");
  const body = await saved.json() as { key: { provider: string; lastFour: string; savedAt: string } };
  expect(body).toEqual({ key: { provider: "anthropic", lastFour: "abcd", savedAt: expect.any(String) }, unreadable: false });
  expect(readAssistantKey("ada")).toMatchObject({ key: KEY });
  expect(await (await ada(URL_PATH)).json()).toEqual(body);

  await ada(URL_PATH, put({ provider: "openai", key: OTHER }));
  expect(assistantKeyFacts("ada")).toMatchObject({ provider: "openai", lastFour: "wxyz" });

  expect(await (await ada(URL_PATH, { method: "DELETE" })).json()).toEqual({ removed: true });
  expect(await (await ada(URL_PATH, { method: "DELETE" })).json()).toEqual({ removed: false });
  expect(await (await ada(URL_PATH)).json()).toEqual({ key: null, unreadable: false });
});

it.each([
  ["a key too short", { provider: "anthropic", key: "short-key" }],
  ["a key too long", { provider: "anthropic", key: "k".repeat(513) }],
  ["whitespace inside", { provider: "anthropic", key: "operations key value" }],
  ["a control character inside", { provider: "anthropic", key: "operations\u0007key-value" }],
  ["an unknown provider", { provider: "mistral", key: KEY }],
  ["a key that is not text", { provider: "anthropic", key: 1234567890123456 }],
  ["no provider", { key: KEY }],
])("refuses %s, says nothing of what was sent and keeps the previous key", async (_name, body) => {
  const ada = person("ada");
  await ada(URL_PATH, put({ provider: "openai", key: OTHER }));
  const refused = await ada(URL_PATH, put(body));
  expect(refused.status).toBe(400);
  const text = await refused.text();
  expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_request" } });
  for (const sent of [KEY, "short-key", "operations key value", "operations\u0007key-value", "mistral", "kkkkkkkk"]) expect(text).not.toContain(JSON.stringify(sent).slice(1, -1));
  expect(readAssistantKey("ada")).toMatchObject({ key: OTHER, provider: "openai" });
});

it("answers unreadable for a saved key that no longer opens, and a new save mends it", async () => {
  const ada = person("ada");
  await ada(URL_PATH, put({ provider: "anthropic", key: KEY }));
  metadataDb().prepare("UPDATE assistant_keys SET key_encrypted = 'v1:not-a-sealed-value' WHERE account_id = 'ada'").run();
  expect(await (await ada(URL_PATH)).json()).toMatchObject({ key: { lastFour: "abcd" }, unreadable: true });
  expect(await (await ada(URL_PATH, put({ provider: "anthropic", key: OTHER }))).json()).toMatchObject({ key: { lastFour: "wxyz" }, unreadable: false });
});

describe("another person's key", () => {
  it("an admin's token can neither set, read nor remove a member's key by naming the account", async () => {
    const admin = person("root", true), ada = person("ada");
    await ada(URL_PATH, put({ provider: "anthropic", key: KEY }));

    // In the body: refused, and nothing changes for anyone.
    for (const field of ["accountId", "account", "id"]) {
      expect((await admin(URL_PATH, put({ provider: "openai", key: OTHER, [field]: "ada" }))).status).toBe(400);
    }
    expect(readAssistantKey("root")).toBeNull();
    // In the address: the answer is the admin's own, and the member's key stays.
    expect(await (await admin(`${URL_PATH}?accountId=ada&account=ada`)).json()).toEqual({ key: null, unreadable: false });
    expect(await (await admin(`${URL_PATH}?accountId=ada`, { method: "DELETE" })).json()).toEqual({ removed: false });
    const own = await admin(`${URL_PATH}?accountId=ada`, put({ provider: "openai", key: OTHER }));
    expect(own.status).toBe(200);
    expect(readAssistantKey("root")).toMatchObject({ key: OTHER });
    expect(readAssistantKey("ada")).toMatchObject({ key: KEY, provider: "anthropic" });
    // As a precondition: refused before dispatch.
    expect((await admin(URL_PATH, { headers: { "x-dezfil-account": "ada" } })).status).toBe(401);
    // No address of an account's own answers for this key.
    expect((await admin(`/api/users/ada`)).status).not.toBe(500);
    expect(JSON.stringify(buildOpenApiDocument().paths)).not.toMatch(/users\/[^"]*assistant-key/);
  });
});

it("refuses a save whose credential was revoked while its body was on the way", async () => {
  const ada = person("ada");
  let release = () => {};
  const body = new ReadableStream({ start(controller) {
    release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ provider: "anthropic", key: KEY }))); controller.close(); };
  } });
  const pending = ada(URL_PATH, { method: "PUT", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
  await new Promise(resolve => setTimeout(resolve, 20));
  metadataDb().prepare("UPDATE auth_tokens SET revoked_at = ? WHERE account_id = 'ada'").run(Date.now());
  setOwnKey("ada", "openai", OTHER);
  release();
  expect((await pending).status).toBe(401);
  expect(readAssistantKey("ada")).toMatchObject({ key: OTHER });
});

it("needs a credential, and a cookie write from another origin is refused at the gate", async () => {
  const ada = person("ada");
  const anonymous = await (await import("@/app/api/account/assistant-key/route")).GET(socketRequest(new Request(`${origin}${URL_PATH}`)));
  expect(anonymous.status).toBe(401);
  const write = (from: string) => socketRequest(new Request(`${origin}${URL_PATH}`, { method: "PUT", headers: { cookie: ada.cookie, origin: from, "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", key: KEY }) }));
  expect(gateRequest(write("http://elsewhere.example")).status).toBe(403);
  expect(gateRequest(write(origin)).headers.get("x-middleware-next")).toBe("1");
});

it("publishes the three operations with their tools, removal asking first and the key write-only", () => {
  const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
  expect(tools.get("get_assistant_key")).toMatchObject({ method: "get", path: URL_PATH, confirm: false, effects: { readOnly: true, keptFromAssistant: true } });
  expect(tools.get("set_assistant_key")).toMatchObject({ method: "put", path: URL_PATH, confirm: false, effects: { readOnly: false, keptFromAssistant: true } });
  const removal = tools.get("remove_assistant_key")!;
  expect(removal).toMatchObject({ method: "delete", path: URL_PATH, confirm: true, effects: { readOnly: false, keptFromAssistant: true } });
  expect(removal.confirmation?.consequence).toContain("Turns in progress stop.");
  const operation = buildOpenApiDocument().paths[URL_PATH] as unknown as { put: { requestBody: { content: { "application/json": { schema: { properties: { key: { writeOnly?: boolean } }; additionalProperties: boolean } } } } } };
  const schema = operation.put.requestBody.content["application/json"].schema;
  expect(schema.properties.key.writeOnly).toBe(true);
  expect(schema.additionalProperties).toBe(false);
});
