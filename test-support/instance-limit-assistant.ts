import type { AccountScope } from "../src/lib/auth/scope";
import type { AuthContext } from "../src/lib/auth/credentials";
import { dispatchAssistantTestRoute } from "../src/lib/assistant/testing/route-dispatch";
import { stubProvider } from "../src/lib/assistant/providers/stub";
import { PendingActionStore } from "../src/lib/assistant/pending";
import { runAssistant, resumeAssistant, type LoopDeps } from "../src/lib/assistant/loop";
import { AssistantRunStore } from "../src/lib/assistant/runs";
import { instanceFetch } from "../src/lib/auth/instance-fetch";

/** A deterministic tool choice, with real approval, delegated HTTP execution and receipts. */
export async function recordCreationAttempt(scope: AccountScope, context: AuthContext, tool: string, args: Record<string, unknown>) {
  const store = new AssistantRunStore(), receipt = store.reserve(scope);
  store.bind(scope, receipt.id, { message: "Create it" });
  const fetchImpl: typeof fetch = (input, init) => dispatchAssistantTestRoute(new Request(input, init));
  const provider = stubProvider([
    { text: "", toolCalls: [{ id: "creation", name: tool, args }] },
    { text: "The creation request ended.", toolCalls: [] },
  ]);
  const pending = new PendingActionStore();
  const deps: LoopDeps = {
    scope, baseUrl: "http://instance.test", fetchImpl: instanceFetch("http://instance.test", context, fetchImpl),
    autoCheck: false, offerMode: "full", pending,
  };
  for await (const event of runAssistant(provider, { message: "Create it", history: [] }, deps)) {
    store.record(scope, receipt.id, event);
    if (event.type === "confirm_required") {
      for await (const resumed of resumeAssistant(pending.claim(scope, event.id, "approved")!, true, deps)) store.record(scope, receipt.id, resumed);
    }
  }
  return { actions: store.read(scope, receipt.id).actions, outcome: JSON.parse(provider.recording.exchanges[0].outcomes[0][0].body) };
}
