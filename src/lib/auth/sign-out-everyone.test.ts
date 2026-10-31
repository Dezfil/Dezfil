import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { externalFixture } from "../../../test-support/external-sign-in";
import { arriveExternalSignIn } from "./external-sign-in/arrival";
import { getAccountByEmail } from "@/lib/metadata/accounts";
import { authenticateSession, createApiToken, issueSession } from "./credentials";
import { accountScope, type AccountScope } from "./scope";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { POST } from "@/app/api/instance/sign-out/route";
import { signEveryoneOut } from "./sign-out-everyone";
import { initializeAuthGenerations } from "./generations";
import { assistantRuns } from "@/lib/assistant/runs";
import { pendingActions } from "@/lib/assistant/pending";
import { runAssistant } from "@/lib/assistant/loop";
import { runStream } from "@/lib/assistant/run-stream";
import { executionControl } from "@/lib/assistant/execution-control";
import { retainAssistantCleanup } from "@/lib/assistant/retained-work";
import type { ModelProvider, ProviderReply } from "@/lib/assistant/provider";
import { buildTools } from "@/lib/tools/tools";
import { testClient } from "@/lib/mcp/test-client";
let f: ReturnType<typeof externalFixture>;
beforeEach(async () => { f = externalFixture(); expect((await arriveExternalSignIn(f.request())).status).toBe(200); });
afterEach(() => { pendingActions.resetForTests(); assistantRuns.resetForTests(); vi.unstubAllGlobals(); f.close(); });
function currentOwner() {
  const session = issueSession(getAccountByEmail("owner@example.test", f.db)!, f.db, Date.now());
  const context = authenticateSession(session.secret, f.db)!;
  return { context, scope: accountScope(context, f.db), secret: session.secret };
}
function held(scope: AccountScope) {
  const hold = Promise.withResolvers<ProviderReply>(), entered = Promise.withResolvers<void>(); let signal: AbortSignal | undefined;
  const id = assistantRuns.reserve(scope).id; assistantRuns.bind(scope, id, {});
  const control = executionControl(scope, id, new Request("https://instance.test/api/assistant/messages"));
  const provider: ModelProvider = { id: "held", model: "held", exchange() { return {
    send(_text, options) { signal = options?.signal; entered.resolve(); return hold.promise; },
    async continueWith() { throw new Error("Unexpected continuation"); },
  }; } };
  const response = runStream(scope, runAssistant(provider, { message: "Wait", history: [] },
    { scope, runId: id, baseUrl: "https://instance.test", signal: control.signal, autoCheck: false }), id, control);
  const result = response.text().then(text => ({ text }), error => ({ error }));
  return { id, entered: entered.promise, result, get signal() { return signal; }, release() { hold.resolve({ text: "finished", toolCalls: [] }); } };
}
it.each(["admin", "ticket", "floor"])("a %s raise ends all older running and parked turns while a fresh session's turn survives", async kind => {
  const owner = currentOwner(), member = testAccountScope(f.db, "member");
  const old = [held(owner.scope), held(member)]; await Promise.all(old.map(turn => turn.entered));
  const dispose = vi.fn();
  const parked = pendingActions.park(member, { exchange: { async send() { throw new Error("Resumed old park"); }, async continueWith() { throw new Error("Resumed old park"); }, dispose },
    policy: "full", calls: [], index: 0, outcomes: [], steps: 1, headers: {} });
  const cleaned: string[] = []; retainAssistantCleanup(owner.scope.accountId, () => cleaned.push("old"));
  let fresh: ReturnType<typeof held> | undefined;
  try {
    if (kind === "admin") signEveryoneOut(owner.context, f.db);
    else if (kind === "ticket") expect((await arriveExternalSignIn(f.request(f.ticket({ door_generation: 5 })))).status).toBe(200);
    else {
      vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_GENERATION_FLOOR", "5"); Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
      expect(initializeAuthGenerations(f.db)).toBe(true);
    }
    for (const turn of old) { expect(turn.signal?.aborted).toBe(true); expect(await turn.result).toHaveProperty("error"); }
    expect(pendingActions.peek(member, parked)).toBeUndefined(); expect(dispose).toHaveBeenCalledOnce();
    const next = currentOwner(); fresh = held(next.scope); await fresh.entered;
    const detachNew = retainAssistantCleanup(next.scope.accountId, () => cleaned.push("new"));
    expect(fresh.signal?.aborted).toBe(false);
    for (const turn of old) turn.release();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    expect(cleaned).toEqual(["old"]); expect(fresh.signal?.aborted).toBe(false);
    expect(assistantRuns.read(next.scope, old[0].id).state).toBe("interrupted");
    expect(pendingActions.claim(testAccountScope(f.db, "member"), parked, "approved")).toBeUndefined();
    expect(pendingActions.resolutionOf(member, parked)).toBe("superseded");
    fresh.release(); expect(await fresh.result).toHaveProperty("text", expect.stringContaining("finished")); detachNew();
  } finally { old.forEach(turn => turn.release()); fresh?.release(); await new Promise(resolve => setImmediate(resolve)); }
});
it("exposes the confirmed destructive tool and calls the admin operation through its generated schema", async () => {
  const owner = currentOwner(), token = createApiToken(owner.context, "Admin", f.db);
  const tool = buildTools().find(tool => tool.name === "sign_everyone_out")!;
  expect(tool.confirm).toBe(true); expect(JSON.stringify(tool)).toContain("your own included");
  const client = await testClient(() => POST(socketRequest(new Request("https://instance.test/api/instance/sign-out", { method: "POST", headers: { authorization: `Bearer ${token.secret}` } }))));
  try {
    const result = await client.callTool({ name: "sign_everyone_out", arguments: {} }); expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("signOutGeneration"); expect(authenticateSession(owner.secret, f.db)).toBeNull();
  } finally { await client.close(); }
});
it("refuses non-admin callers without raising either generation", async () => {
  testAccountScope(f.db, "member"); const member = getAccountByEmail("member@example.test", f.db)!;
  const context = authenticateSession(issueSession(member, f.db, Date.now()).secret, f.db)!;
  expect(() => signEveryoneOut(context, f.db)).toThrow(expect.objectContaining({ code: "forbidden" }));
  expect(f.db.prepare("SELECT sign_out_generation,door_generation FROM auth_generations").get()).toEqual({ sign_out_generation: 0, door_generation: 0 });
});
