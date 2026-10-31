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
import { setOwnKey } from "./change";

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
    ["tokens", await member("/api/account/tokens")],
    ["pending", await member("/api/assistant/pending")],
    ["member config", await member("/api/config")],
    ["users", await admin("/api/users")],
    ["directory", await admin("/api/accounts/search?q=ada")],
    ["member directory", await member("/api/accounts/search?q=ada")],
    ["deletion preview", await admin("/api/users/ada/deletion-preview")],
    ["settings", await admin("/api/instance/settings")],
    ["storage", await admin("/api/instance/storage")],
    ["config", await admin("/api/config")],
    ["admin status", await admin("/api/assistant")],
    ...(runId ? [["run receipt", await member(`/api/assistant/runs/${runId}`)] as [string, Response]] : []),
  ];
  const seen: Record<string, number> = {};
  for (const [name, response] of reads) {
    const text = await response.text();
    seen[name] = response.status;
    expect(text.includes(CANARY), `${name} carries the key`).toBe(false);
  }
  return seen;
}
const status = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

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
