import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { ModelProvider, ProviderCallOptions, ProviderExchange, ProviderReply } from "../provider";
import { scrubKey } from "../providers/scrub";
import { isCurrentSave } from "./store";

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
  const clean = (reply: ProviderReply): ProviderReply => ({ ...reply, text: scrubKey(reply.text, own.key) });
  const control = (given?: ProviderCallOptions): ProviderCallOptions => ({
    ...given, onTextDelta: (text) => given?.onTextDelta?.(scrubKey(text, own.key)),
  });
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
        async send(text, given) { current(); return clean(await exchange.send(text, control(given))); },
        async continueWith(outcomes, given) { current(); return clean(await exchange.continueWith(outcomes, control(given))); },
        async continueWithImage(continuation, given) { current(); return clean(await exchange.continueWithImage!(continuation, control(given))); },
      };
      return bound;
    },
  };
}
