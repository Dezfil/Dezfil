import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { authenticateSession, createApiToken, issueSession } from "@/lib/auth/credentials";
import { getAccount } from "@/lib/metadata/accounts";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountScope } from "@/lib/test-support/accounts";
import { assistantRuns } from "../runs";
import { pendingActions } from "../pending";
import { dispatchAssistantTestRoute } from "../testing/route-dispatch";
import { anthropicEvents, outputText, responseWire, sse } from "../testing/wire";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { setOwnKey } from "./change";
import { readAssistantKey } from "./store";

/**
 * A recognisable key walked through every surface a person, an admin or a log
 * can read. The route, the stores, the SDK clients and the data folder are real;
 * the network is a stand-in, which answers with what a provider really does: the
 * key echoed back in an error, or in a reply.
 */

const origin = "http://127.0.0.1:3218";
const CANARY = "sk-canary-recognisable-value-0123456789";
let dir: string;
let logged: string[] = [];
let answer: () => Response | Promise<Response>;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-key-canary-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3218");
  closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map((arg) => inspect(arg, { depth: 8 })).join(" ")); });
  }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
    return answer();
  });
});
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); resetSecretKeyCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function person(id: string, admin = false) {
  const db = metadataDb();
  testAccountScope(db, id);
  if (admin) db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(id);
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  const token = createApiToken(context, "Route fixture", db).secret;
  return (url: string, init: RequestInit = {}) => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }));
}
async function turn(call: ReturnType<typeof person>) {
  const runId = (await (await call("/api/assistant/runs", { method: "POST" })).json() as { id: string }).id;
  const response = await call("/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Hello.", history: [] }) });
  return { runId, stream: await response.text() };
}
function walk(root: string): string[] {
  return readdirSync(root).flatMap((name) => { const at = path.join(root, name); return statSync(at).isDirectory() ? walk(at) : [at]; });
}
/** Every durable byte: the metadata store's files and everything else in the data folder. */
function expectNoPlaintextOnDisk() {
  metadataDb().pragma("wal_checkpoint(TRUNCATE)");
  const files = walk(dir);
  expect(files.some((file) => file.endsWith("metadata.sqlite"))).toBe(true);
  for (const file of files) expect(readFileSync(file).includes(Buffer.from(CANARY)), file).toBe(false);
}
/** What an admin and the person can read about accounts and the instance. */
async function everyRead(member: ReturnType<typeof person>, admin: ReturnType<typeof person>, runId?: string) {
  const reads: [string, Response][] = [
    ["status", await member("/api/assistant")],
    ["account", await member("/api/account")],
    ["key status", await member("/api/account/assistant-key")],
    ["tokens", await member("/api/account/tokens")],
    ["pending", await member("/api/assistant/pending")],
    ["member config", await member("/api/config")],
    ["users", await admin("/api/users")],
    ["directory", await admin("/api/accounts/search?q=ada")],
    ["member directory", await member("/api/accounts/search?q=ada")],
    ["settings", await admin("/api/instance/settings")],
    ["storage", await admin("/api/instance/storage")],
    ["config", await admin("/api/config")],
    ["admin status", await admin("/api/assistant")],
    ...(runId ? [["run receipt", await member(`/api/assistant/runs/${runId}`)] as [string, Response]] : []),
  ];
  // An account has a deletion preview once deactivated, which keeps its key.
  metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'ada'").run();
  reads.push(["deletion preview", await admin("/api/users/ada/deletion-preview")]);
  for (const [name, response] of reads) {
    expect(response.status, name).toBe(200);
    const text = await response.text();
    expect(text.includes(CANARY), `${name} carries the key`).toBe(false);
  }
}
const status = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const rejectedByAnthropic = () => status(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${CANARY}` } });

describe.each([
  ["anthropic" as const, () => status(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${CANARY}` } }),
    () => status(500, { type: "error", error: { type: "api_error", message: `upstream refused ${CANARY}` } }),
    () => sse(anthropicEvents([{ type: "text", text: `Your key is ${CANARY}.` }]), true), "Your Anthropic key was rejected."],
  ["openai" as const, () => status(401, { error: { message: `Incorrect API key provided: ${CANARY}`, type: "invalid_request_error", code: "invalid_api_key" } }),
    () => status(500, { error: { message: `upstream refused ${CANARY}`, type: "server_error" } }),
    () => responseWire([outputText(`Your key is ${CANARY}.`)]), "Your OpenAI key was rejected."],
])("a key saved for %s", (provider, rejected, failing, echoing, sentence) => {
  beforeEach(() => { person("ada"); setOwnKey("ada", provider, CANARY); });

  it("never appears when the provider rejects it and echoes it back", async () => {
    const member = person("ada"), admin = person("root", true);
    answer = rejected;
    const { runId, stream } = await turn(member);
    expect(stream).not.toContain(CANARY);
    const failure = stream.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; code?: string; message?: string; detail?: string }).find((event) => event.type === "error")!;
    expect(failure).toMatchObject({ code: "assistant_auth", message: sentence });
    // The provider's own words stand behind the sentence, without the key.
    expect(failure.detail).toMatch(/invalid x-api-key|Incorrect API key/);
    expect(failure.detail).not.toContain(CANARY);
    const receipt = await (await member(`/api/assistant/runs/${runId}`)).json() as { state: string; error: { code: string; message: string; detail: string } };
    expect(receipt).toMatchObject({ state: "failed", error: { code: "assistant_auth", message: sentence } });
    expect(receipt.error.detail).toBe(failure.detail);
    await everyRead(member, admin, runId);
    expect(logged.join("\n")).not.toContain(CANARY);
    expectNoPlaintextOnDisk();
  });

  it("never appears when another provider failure echoes it", async () => {
    const member = person("ada");
    answer = failing;
    const { runId, stream } = await turn(member);
    expect(stream).not.toContain(CANARY);
    expect(stream).toContain("assistant_provider");
    expect(stream).toContain("upstream refused");
    expect(JSON.stringify(await (await member(`/api/assistant/runs/${runId}`)).json())).not.toContain(CANARY);
    expect(logged.join("\n")).not.toContain(CANARY);
  });

  it("never appears when a reply echoes it", async () => {
    const member = person("ada");
    answer = echoing;
    const { runId, stream } = await turn(member);
    expect(stream).not.toContain(CANARY);
    expect(stream).toContain("Your key is");
    expect(JSON.stringify(await (await member(`/api/assistant/runs/${runId}`)).json())).not.toContain(CANARY);
  });

  it("never reaches the log when the connection itself fails with it in the message", async () => {
    const member = person("ada");
    answer = () => { throw Object.assign(new TypeError(`fetch failed for ${CANARY}`), { cause: new Error(`socket ${CANARY}`) }); };
    const { runId, stream } = await turn(member);
    expect(stream).not.toContain(CANARY);
    expect(stream).toContain('"type":"error"');
    expect(JSON.stringify(await (await member(`/api/assistant/runs/${runId}`)).json())).not.toContain(CANARY);
    expect(logged.join("\n")).not.toContain(CANARY);
  });
});

it("words a rejected instance key for an admin, with no variable name and the provider's words behind detail", async () => {
  const secret = "sk-instance-key-from-the-server-0000";
  vi.stubEnv("ANTHROPIC_API_KEY", secret);
  const member = person("ada");
  answer = () => status(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${secret}` } });
  const { stream } = await turn(member);
  expect(stream).not.toContain(secret);
  const failure = stream.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; message?: string; detail?: string }).find((event) => event.type === "error")!;
  expect(failure.message).toBe("The instance's Anthropic key was rejected. An admin must replace it.");
  expect(failure.message).not.toMatch(/API_KEY|restart/);
  expect(failure.detail).toContain("invalid x-api-key");
});

describe("set through the operations", () => {
  const body = (provider: string, key: string): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, key }) });

  it("through the UI's operation, refused once and saved once, says it back nowhere", async () => {
    const ada = person("ada"), admin = person("root", true);
    answer = () => { throw new Error("Saving makes no provider call."); };
    const refused = await ada("/api/account/assistant-key", body("anthropic", `${CANARY} with spaces`));
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(CANARY);
    const saved = await ada("/api/account/assistant-key", body("anthropic", CANARY));
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(CANARY);
    answer = rejectedByAnthropic;
    const { runId, stream } = await turn(ada);
    expect(stream).toContain("Your Anthropic key was rejected.");
    expect(stream).not.toContain(CANARY);
    await everyRead(ada, admin, runId);
    expect(logged.join("\n")).not.toContain(CANARY);
    expectNoPlaintextOnDisk();
  });

  it("through the MCP tool, refused once and saved once, its own results holding none of it", async () => {
    const ada = person("ada"), admin = person("root", true);
    const token = createApiToken(authenticateSession(issueSession(getAccount("ada")!, metadataDb(), Date.now()).secret, metadataDb())!, "MCP client", metadataDb()).secret;
    // The real endpoint, signed in as the person, dispatching back to the routes.
    const client = new Client({ name: "canary-client", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toEqual(expect.arrayContaining(["get_assistant_key", "set_assistant_key", "remove_assistant_key"]));
      const refused = await client.callTool({ name: "set_assistant_key", arguments: { provider: "anthropic", key: `${CANARY} with spaces` } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      const notAProvider = await client.callTool({ name: "set_assistant_key", arguments: { provider: 7, key: CANARY } }).catch((error: unknown) => ({ thrown: String(error), isError: true }));
      expect(notAProvider.isError).toBe(true);
      expect(JSON.stringify(notAProvider)).not.toContain(CANARY);
      const saved = await client.callTool({ name: "set_assistant_key", arguments: { provider: "openai", key: CANARY } });
      expect(saved.isError ?? false).toBe(false);
      expect(JSON.stringify(saved)).toContain("lastFour");
      expect(JSON.stringify(saved)).not.toContain(CANARY);
      const read = await client.callTool({ name: "get_assistant_key", arguments: {} });
      expect(JSON.stringify(read)).not.toContain(CANARY);
    } finally { await client.close(); }
    expect(readAssistantKey("ada")).toMatchObject({ key: CANARY, provider: "openai" });
    await everyRead(ada, admin);
    expect(logged.join("\n")).not.toContain(CANARY);
    expectNoPlaintextOnDisk();
  });

  it.each([
    ["sql", { page: "sql", draft: "", selection: null, lastExecution: null }], ["no page", undefined],
  ])("a forced call in a turn on %s is refused, reaching nothing and recording nothing", async (_page, context) => {
    const ada = person("ada");
    setOwnKey("ada", "anthropic", `first-${CANARY}`);
    const replies = [
      () => sse(anthropicEvents([{ type: "tool_use", id: "forced", name: "set_assistant_key", input: { provider: "openai", key: CANARY } }], "tool_use"), true),
      () => sse(anthropicEvents([{ type: "text", text: "Done." }]), true),
    ];
    answer = () => replies.shift()!();
    const runId = (await (await ada("/api/assistant/runs", { method: "POST" })).json() as { id: string }).id;
    const response = await ada("/api/assistant/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Hello.", history: [], ...(context ? { context } : {}) }) });
    const stream = await response.text();
    expect(stream).toContain("assistant_action_not_admitted");
    expect(stream).not.toContain(CANARY);
    expect(readAssistantKey("ada")).toMatchObject({ key: `first-${CANARY}`, provider: "anthropic" });
    expect(await (await ada(`/api/assistant/runs/${runId}`)).text()).not.toContain(CANARY);
    expect(logged.join("\n")).not.toContain(CANARY);
  });
});
