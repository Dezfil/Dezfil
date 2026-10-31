import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { ModelProvider, ProviderExchange } from "../provider";
import { isCurrentSave } from "./store";

/**
 * Every provider request of a turn on a person's key is made only while the
 * key it bound is still theirs. A change through this server already ends the
 * turn; this is what holds for a change it cannot signal, such as the recovery
 * script working on the store from another process.
 */
export function boundToSave(provider: ModelProvider, accountId: string, save: string): ModelProvider {
  const current = () => {
    if (!isCurrentSave(accountId, save)) throw new ApiError("assistant_key_changed", ERROR_CATALOGUE.assistant_key_changed, 409);
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
        async send(text, control) { current(); return exchange.send(text, control); },
        async continueWith(outcomes, control) { current(); return exchange.continueWith(outcomes, control); },
        async continueWithImage(continuation, control) { current(); return exchange.continueWithImage!(continuation, control); },
      };
      return bound;
    },
  };
}
