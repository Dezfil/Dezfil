import OpenAI from "openai";
import { ProviderError, type ModelProvider } from "../provider";
import { bareOpenAIOptions, type KeyPayer } from "./bare-client";
import { rejectedKeySentence } from "./api-failure";
import { openaiFailureSentence } from "./openai-error";
import { scrubbedError, scrubKey } from "./scrub";
import { responsesExchange } from "./openai-responses";

function mapError(error: unknown, apiKey: string, payer: KeyPayer): never {
  if (error instanceof OpenAI.AuthenticationError) {
    throw new ProviderError(rejectedKeySentence("OpenAI", payer), "auth", scrubKey(error.message, apiKey));
  }
  if (error instanceof OpenAI.APIError) {
    throw new ProviderError(scrubKey(openaiFailureSentence(error), apiKey), "provider");
  }
  throw scrubbedError(error, apiKey);
}

export function openaiProvider(apiKey: string, model: string, fetchImpl?: typeof fetch, effort?: string, payer: KeyPayer = "instance"): ModelProvider {
  const client = new OpenAI({ ...(payer === "own" ? bareOpenAIOptions(apiKey) : { apiKey }), maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { id: "openai", model, effort, exchange(options) {
    const exchange = responsesExchange(client, model, options, effort);
    return {
      dispose() { exchange.dispose?.(); },
      retainedForTests: () => exchange.retainedForTests!(),
      setGrounding(value) { exchange.setGrounding?.(value); },
      extendTools(tools) { exchange.extendTools?.(tools); },
      async send(text, control) { try { return await exchange.send(text, control); } catch (error) { mapError(error, apiKey, payer); } },
      async continueWith(outcomes, control) { try { return await exchange.continueWith(outcomes, control); } catch (error) { mapError(error, apiKey, payer); } },
      async continueWithImage(continuation, control) { try { return await exchange.continueWithImage!(continuation, control); } catch (error) { mapError(error, apiKey, payer); } },
    };
  } };
}
