import OpenAI from "openai";
import { ProviderError, type ModelProvider } from "../provider";
import { openaiFailureSentence } from "./openai-error";
import { responsesExchange } from "./openai-responses";

function mapError(error: unknown): never {
  if (error instanceof OpenAI.AuthenticationError) {
    throw new ProviderError(
      "The configured OpenAI API key was rejected. Check OPENAI_API_KEY and restart.",
      "auth",
    );
  }
  if (error instanceof OpenAI.APIError) {
    throw new ProviderError(
      openaiFailureSentence(error),
      "provider",
    );
  }
  throw error;
}

export function openaiProvider(apiKey: string, model: string, fetchImpl?: typeof fetch, effort?: string): ModelProvider {
  const client = new OpenAI({ apiKey, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return { id: "openai", model, effort, exchange(options) {
    const exchange = responsesExchange(client, model, options, effort);
    return {
      setGrounding(value) { exchange.setGrounding?.(value); },
      extendTools(tools) { exchange.extendTools?.(tools); },
      async send(text, control) { try { return await exchange.send(text, control); } catch (error) { mapError(error); } },
      async continueWith(outcomes, control) { try { return await exchange.continueWith(outcomes, control); } catch (error) { mapError(error); } },
      async continueWithImage(continuation, control) { try { return await exchange.continueWithImage!(continuation, control); } catch (error) { mapError(error); } },
    };
  } };
}
