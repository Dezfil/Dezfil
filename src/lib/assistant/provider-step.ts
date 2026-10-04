import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { randomUUID } from "node:crypto";
import type { AssistantEvent } from "./loop";
import type { ProviderCallOptions, ProviderReply } from "./provider";
import { assistantRuns } from "./runs";

/** Drain provider text while its request is unresolved. Only the final reply
 * crosses into tool admission; no partial call can escape this boundary.
 *
 * It is also the provider-completion seam: every completed response
 * passes through here exactly once, whether or not it carried text, so
 * the record sees a tool-only reply and a silent observation as plainly
 * as a message. */
export async function* streamReply(
  scope: AccountScope,
  request: (options: ProviderCallOptions) => Promise<ProviderReply>,
  signal?: AbortSignal,
  runId?: string,
): AsyncGenerator<AssistantEvent, ProviderReply> {
  requireAccountScope(scope);
  const messageId = randomUUID();
  const chunks: string[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let reply: ProviderReply | undefined;
  let failure: unknown;
  const work = Promise.resolve().then(() => request({ signal, onTextDelta(text) { if (text) { chunks.push(text); wake?.(); } } })).then(
    (value) => { reply = value; },
    (error) => { failure = error; },
  ).finally(() => { settled = true; wake?.(); });
  try {
  while (!settled || chunks.length) {
    while (chunks.length) { requireAccountScope(scope); yield { type: "text_delta", messageId, text: chunks.shift()! }; }
    if (!settled) await new Promise<void>((resolve) => { wake = resolve; });
  }
  await work;
  if (failure !== undefined) throw failure;
  if (!reply) throw new Error("Provider completed without a reply");
  // One completed response: the identity it reported, or that it reported
  // none. A failure above returns before here, so no answer is recorded
  // for a request that never completed.
  requireAccountScope(scope);
  if (runId) assistantRuns.reported(scope, runId, reply.model);
  return { ...reply, messageId };
  } finally { await work; chunks.length = 0; reply = undefined; failure = undefined; wake = undefined; }
}
