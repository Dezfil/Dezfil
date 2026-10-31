import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { authenticateSession, createApiToken, issueSession, type AuthContext } from "@/lib/auth/credentials";
import { changeAccountAccess, issueSignInLink } from "@/lib/auth/admin";
import { changeOwnPassword } from "@/lib/auth/accounts";
import { authenticateDelegation, delegateCredential } from "@/lib/auth/delegation";
import { redeemSignInLink } from "@/lib/auth/links";
import { recoverAdmin } from "@/lib/auth/recovery.mjs";
import { signEveryoneOut } from "@/lib/auth/sign-out-everyone";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { assistantRuns } from "../runs";
import { pendingActions } from "../pending";
import { dispatchAssistantTestRoute } from "../testing/route-dispatch";
import { outputCall, outputText, responseWire } from "../testing/wire";
import { setOwnKey } from "./change";
import { readAssistantKey } from "./store";

/**
 * Somebody took an account over and the person got it back. The routes, stores
 * and credentials are real; the network is a stand-in that says which key paid.
 * Nothing the taker held can spend the key the person adds afterwards.
 */

const origin = "http://127.0.0.1:3216";
const INSTANCE = "sk-instance-key-0000000000000000", OWNER = "sk-owners-new-key-0000000000000";
const PASSWORD = "field notebooks at dawn", OWNERS = "harbour charts at noon";
let dir: string, seen: string[] = [], reply: () => Response | Promise<Response>;

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-key-takeover-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("PORT", "3216");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", INSTANCE);
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  seen = []; reply = () => responseWire([outputText("Done.")]);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
    seen.push(new Headers(init?.headers ?? request.headers).get("authorization")!.replace("Bearer ", ""));
    return reply();
  });
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

function client(bearer: string) {
  const call = (url: string, init: RequestInit = {}) => dispatchAssistantTestRoute(new Request(`${origin}${url}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${bearer}` } }));
  const json = { "content-type": "application/json" };
  return {
    call,
    async turn() {
      const reserved = await call("/api/assistant/runs", { method: "POST" });
      const runId = (await reserved.json() as { id: string }).id;
      return { runId, response: await call("/api/assistant/messages", { method: "POST", headers: json, body: JSON.stringify({ runId, message: "Work.", history: [] }) }) };
    },
    resolve: (pending: string) => call("/api/assistant/messages", { method: "POST", headers: json, body: JSON.stringify({ resolution: { pending, approved: true } }) }),
    saveKey: (key: string) => call("/api/account/assistant-key", { method: "PUT", headers: json, body: JSON.stringify({ provider: "openai", key }) }),
    pending: async () => (await (await call("/api/assistant/pending")).json() as { pending: { id: string; runId: string }[] }).pending,
  };
}
function signedIn(id: string, admin = false) {
  const db = metadataDb();
  testAccountScope(db, id);
  if (admin) db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(id);
  const context = authenticateSession(issueSession(getAccount(id, db)!, db, Date.now()).secret, db)!;
  return { context, ...client(createApiToken(context, "Route fixture", db).secret) };
}
/** What a taker holds once they are in: a token and a credential delegated from it, and a parked run. */
async function holdings(secret: string) {
  const db = metadataDb();
  const session = await redeemSignInLink(secret, PASSWORD);
  const context = authenticateSession(session.secret, db)!;
  const token = createApiToken(context, "Keep this", db).secret;
  const taker = client(token);
  const scope = testAccountScope(db, context.account.id);
  const map = createMap(scope, "Parked map");
  reply = () => responseWire([outputCall("call-publish", "publish_map", JSON.stringify({ id: map.id }))]);
  await (await taker.turn()).response.text();
  const [parked] = await taker.pending();
  expect(parked).toBeDefined();
  reply = () => responseWire([outputText("Done.")]);
  return { taker, context, parked, delegated: delegateCredential(context as AuthContext, db) };
}
const stale = async (response: Response) => {
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "pending_superseded" } });
};

async function afterRecovery(accountId: string, redeem: () => Promise<{ secret: string }>, taken: Awaited<ReturnType<typeof holdings>>) {
  const { taker, parked, delegated } = taken;
  const db = metadataDb();
  const owner = client(createApiToken(authenticateSession((await redeem()).secret, db)!, "Owner's", db).secret);

  // The token and what was delegated from it are gone, and so is the park.
  expect((await taker.call("/api/account")).status).toBe(401);
  expect(authenticateDelegation(delegated, db)).toBeNull();
  // The old park, resumed with the owner's fresh credentials, is stale, and starts nothing.
  const requests = seen.length;
  await stale(await owner.resolve(parked.id));
  expect(seen).toHaveLength(requests);
  expect(await owner.pending()).toEqual([]);

  // The key the owner adds: the old token can neither reach it nor spend it.
  expect((await owner.saveKey(OWNER)).status).toBe(200);
  expect((await taker.call("/api/assistant/runs", { method: "POST" })).status).toBe(401);
  expect((await taker.call("/api/account/assistant-key")).status).toBe(401);
  expect((await taker.saveKey("sk-takers-key-00000000000000000")).status).toBe(401);
  expect(readAssistantKey(accountId)).toMatchObject({ key: OWNER });

  // The owner's new turn is newer than the redemption, runs on their key and survives.
  const fresh = await owner.turn();
  expect(await fresh.response.text()).toContain("Done.");
  expect(seen.at(-1)).toBe(OWNER);
  expect((await (await owner.call(`/api/assistant/runs/${fresh.runId}`)).json() as { state: string }).state).toBe("completed");
}

describe("taking an account back", () => {
  it("through an admin's new link: the earlier holder's token, delegation and parked run go at the redemption, not before", async () => {
    const admin = signedIn("root", true), ada = signedIn("ada");
    setOwnKey("ada", "openai", "sk-adas-first-key-00000000000000");
    const first = issueSignInLink(admin.context, "ada");
    expect(readAssistantKey("ada")).toBeNull();
    expect((await ada.call("/api/account")).status).toBe(200);

    const taken = await holdings(first.secret!);
    expect((await ada.call("/api/account")).status).toBe(401);

    const second = issueSignInLink(admin.context, "ada");
    // Issuing ends sessions and leaves tokens, as it says.
    expect((await taken.taker.call("/api/account")).status).toBe(200);
    expect(await taken.taker.pending()).toHaveLength(1);

    await afterRecovery("ada", () => redeemSignInLink(second.secret!, OWNERS), taken);
  });

  it("through the recovery script's link, the same", async () => {
    signedIn("root", true);
    const first = recoverAdmin({ dataDir: dir, origin, email: getAccount("root", metadataDb())!.email });
    const secretOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("secret")!;
    const taken = await holdings(secretOf(first.url));
    const second = recoverAdmin({ dataDir: dir, origin, email: getAccount("root", metadataDb())!.email });
    await afterRecovery("root", () => redeemSignInLink(secretOf(second.url), OWNERS), taken);
  });

  it("ends a turn held open at the redemption while a turn begun after it runs on", async () => {
    const admin = signedIn("root", true);
    signedIn("ada");
    const link = issueSignInLink(admin.context, "ada");
    const taken = await holdings(link.secret!);
    const next = issueSignInLink(admin.context, "ada");
    let aborted = false, started = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
      started = true;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true }));
    });
    const held = await taken.taker.turn();
    await vi.waitFor(() => { if (!started) throw new Error("not yet"); });
    const session = await redeemSignInLink(next.secret!, OWNERS);
    await vi.waitFor(() => { if (!aborted) throw new Error("not yet"); });
    expect(await held.response.text()).toContain('"reason":"interrupted"');
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(request.url).origin === origin) return dispatchAssistantTestRoute(request);
      return responseWire([outputText("Done.")]);
    });
    const owner = client(createApiToken(authenticateSession(session.secret, metadataDb())!, "Owner's", metadataDb()).secret);
    expect(await (await owner.turn()).response.text()).toContain("Done.");
  });
});

describe("what leaves keys alone", () => {
  it("a generation raise and a person's own password change keep the key", async () => {
    const db = metadataDb();
    const admin = signedIn("root", true);
    signedIn("ada");
    const link = issueSignInLink(admin.context, "ada");
    const session = await redeemSignInLink(link.secret!, PASSWORD);
    setOwnKey("ada", "openai", OWNER);
    await changeOwnPassword(authenticateSession(session.secret, db)!, PASSWORD, OWNERS);
    expect(readAssistantKey("ada")).toMatchObject({ key: OWNER });
    signEveryoneOut(admin.context);
    expect(readAssistantKey("ada")).toMatchObject({ key: OWNER });
  });

  it("deactivation refuses the person's turns and keeps the key; reactivation returns it", async () => {
    const admin = signedIn("root", true), ada = signedIn("ada");
    metadataDb().prepare("UPDATE accounts SET last_sign_in_at = ? WHERE id = 'ada'").run(new Date().toISOString());
    setOwnKey("ada", "openai", OWNER);
    await changeAccountAccess(admin.context, "ada", { status: "deactivated" });
    expect((await ada.call("/api/assistant/runs", { method: "POST" })).status).toBe(401);
    expect(readAssistantKey("ada")).toMatchObject({ key: OWNER });
    await changeAccountAccess(admin.context, "ada", { status: "active" });
    expect(await (await ada.turn()).response.text()).toContain("Done.");
    expect(seen).toEqual([OWNER]);
  });
});
