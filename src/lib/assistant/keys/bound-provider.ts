import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { ModelProvider, ProviderCallOptions, ProviderExchange, ProviderReply } from "../provider";
import { scrubKey } from "../providers/scrub";
import { isCurrentSave } from "./store";

/** Every string a reply carries, at any depth: its words, tool arguments and identities. */
function withoutKey<T>(value: T, key: string): T;
function withoutKey(value: unknown, key: string): unknown {
  if (typeof value === "string") return scrubKey(value, key);
  if (Array.isArray(value)) return value.map((item) => withoutKey(item, key));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [scrubKey(name, key), withoutKey(item, key)]));
}

/** How much of the end of the text could be the start of this form of the key. */
function startOfKeyAtEnd(text: string, form: string): number {
  for (let length = Math.min(form.length - 1, text.length); length > 0; length -= 1) {
    if (text.endsWith(form.slice(0, length))) return length;
  }
  return 0;
}

/** Deltas split words anywhere, so a split key is whole in neither piece. What
 * could still become the key waits for the next delta; a failed stream never
 * delivers it. */
function deltasWithoutKey(key: string, deliver: (text: string) => void) {
  let waiting = "";
  return {
    push(text: string) {
      const clean = scrubKey(waiting + text, key);
      const held = Math.max(startOfKeyAtEnd(clean, key), startOfKeyAtEnd(clean, encodeURIComponent(key)));
      waiting = clean.slice(clean.length - held);
      if (clean.length > held) deliver(clean.slice(0, clean.length - held));
    },
    end() {
      if (waiting) deliver(waiting);
      waiting = "";
    },
  };
}

/**
 * Every provider request of a turn on a person's key is made only while the
 * key it bound is still theirs. A change through this server already ends the
 * turn; this is what holds for a change it cannot signal, such as the recovery
 * script working on the store from another process. A reply that echoes the
 * key loses it here, before the stream, the record and the next request see it.
 */
export function boundToSave(provider: ModelProvider, accountId: string, own: { key: string; save: string }): ModelProvider {
  const current = () => {
    if (!isCurrentSave(accountId, own.save)) throw new ApiError("assistant_key_changed", ERROR_CATALOGUE.assistant_key_changed, 409);
  };
  const request = async (given: ProviderCallOptions | undefined, ask: (options: ProviderCallOptions) => Promise<ProviderReply>) => {
    current();
    const deltas = deltasWithoutKey(own.key, (text) => given?.onTextDelta?.(text));
    const reply = await ask({ ...given, onTextDelta: deltas.push });
    deltas.end();
    return withoutKey(reply, own.key);
  };
  return {
    id: provider.id,
    model: provider.model,
    effort: provider.effort,
    exchange(options) {
      const exchange = provider.exchange(options);
      const bound: ProviderExchange = {
        dispose: () => exchange.dispose?.(),
        retainedForTests: () => exchange.retainedForTests!(),
        setGrounding: (grounding) => exchange.setGrounding?.(grounding),
        extendTools: (tools) => exchange.extendTools?.(tools),
        send: (text, given) => request(given, (options) => exchange.send(text, options)),
        continueWith: (outcomes, given) => request(given, (options) => exchange.continueWith(outcomes, options)),
        continueWithImage: (continuation, given) => request(given, (options) => exchange.continueWithImage!(continuation, options)),
      };
      return bound;
    },
  };
}
