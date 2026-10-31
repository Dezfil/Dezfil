import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { ProviderError, type ModelProvider, type ProviderCallOptions, type ProviderExchange, type ProviderReply } from "../provider";
import { scrubKey } from "../providers/scrub";
import { isCurrentSave } from "./store";

/** Whether any string at any depth, names included, carries the key. */
function holdsKey(value: unknown, key: string): boolean {
  if (typeof value === "string") return scrubKey(value, key) !== value;
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([name, item]) => holdsKey(name, key) || holdsKey(item, key));
}

/** How much of the end of the text could be the start of this form of the key. */
function startOfKeyAtEnd(text: string, form: string): number {
  for (let length = Math.min(form.length - 1, text.length); length > 0; length -= 1) {
    if (text.endsWith(form.slice(0, length))) return length;
  }
  return 0;
}

/** Words lose the key. Anything else a reply carries is what the turn acts on and
 * answers by name, where a mask would change the meaning, so it stops the turn. */
function replyWithoutKey(reply: ProviderReply, key: string): ProviderReply {
  const { text, ...acted } = reply;
  if (holdsKey(acted, key)) throw new ProviderError("The provider sent your key back in its reply, so nothing was run.", "provider");
  return { ...reply, text: scrubKey(text, key) };
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
    // Deltas split words anywhere, so a split key is whole in neither piece. What
    // could still become the key waits for the next delta; a failed stream never
    // delivers it.
    let waiting = "";
    const reply = await ask({
      ...given,
      onTextDelta(text) {
        const clean = scrubKey(waiting + text, own.key);
        const held = Math.max(startOfKeyAtEnd(clean, own.key), startOfKeyAtEnd(clean, encodeURIComponent(own.key)));
        waiting = clean.slice(clean.length - held);
        if (clean.length > held) given?.onTextDelta?.(clean.slice(0, clean.length - held));
      },
    });
    if (waiting) given?.onTextDelta?.(waiting);
    return replyWithoutKey(reply, own.key);
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
