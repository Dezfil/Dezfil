import { spawn } from "node:child_process";
import path from "node:path";
import { assistantRuns } from "@/lib/assistant/runs";
import { executionControl } from "@/lib/assistant/execution-control";
import { runAssistant } from "@/lib/assistant/loop";
import { runStream } from "@/lib/assistant/run-stream";
import type { ModelProvider, ProviderReply } from "@/lib/assistant/provider";
import type { AccountScope } from "@/lib/auth/scope";
import type { CredentialGenerations } from "@/lib/metadata/auth-generations";

/** Keep a real running turn at the provider boundary without making a request. */
export function heldResetTurn(scope: AccountScope) {
  const hold = Promise.withResolvers<ProviderReply>(), entered = Promise.withResolvers<void>();
  const id = assistantRuns.reserve(scope).id; assistantRuns.bind(scope, id, {});
  const control = executionControl(scope, id, new Request("https://instance.test/api/assistant/messages"));
  const provider: ModelProvider = { id: "held", model: "held", exchange: () => ({
    send() { entered.resolve(); return hold.promise; },
    async continueWith() { throw new Error("Unexpected continuation"); },
  }) };
  const response = runStream(scope, runAssistant(provider, { message: "Wait", history: [] },
    { scope, runId: id, baseUrl: "https://instance.test", signal: control.signal, autoCheck: false }), id, control);
  const result = response.text().then(text => ({ text }), error => ({ error }));
  return { id, entered: entered.promise, result, signal: control.signal,
    release() { hold.resolve({ text: "finished", toolCalls: [] }); } };
}

interface Ready { ready: boolean; pid: number }
interface Result { applied: boolean; generations: CredentialGenerations; logs: string[] }
export function resetContender() {
  const child = spawn(process.execPath, ["--experimental-transform-types", path.resolve("test-support/door-generation-reset-worker.mjs")],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 15000 });
  const ready = Promise.withResolvers<Ready>(), result = Promise.withResolvers<Result>();
  const locked = Promise.withResolvers<void>(), attempting = Promise.withResolvers<void>();
  let output = "", errors = "";
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { errors += chunk; });
  child.on("message", message => {
    const state = message as Ready & { locked?: boolean; attempting?: boolean };
    if (state.ready) ready.resolve(state);
    if (state.locked) locked.resolve();
    if (state.attempting) attempting.resolve();
  });
  const fail = (error: Error) => { ready.reject(error); locked.reject(error); attempting.reject(error); result.reject(error); };
  child.once("error", fail);
  child.once("close", code => {
    if (code !== 0) fail(new Error(`Reset worker exited ${code}: ${errors}`));
    else { try { result.resolve(JSON.parse(output)); } catch (error) { fail(error as Error); } }
  });
  for (const promise of [ready.promise, locked.promise, attempting.promise, result.promise]) void promise.catch(() => {});
  return { ready: ready.promise, locked: locked.promise, attempting: attempting.promise, result: result.promise,
    hold: () => child.send("hold"), release: () => child.send("release"), stop: () => child.kill() };
}
