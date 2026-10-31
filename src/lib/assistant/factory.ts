import { assistantAvailability } from "./config";
import { boundToSave } from "./keys/bound-provider";
import type { KeyProvider } from "./keys/store";
import type { ModelProvider } from "./provider";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";

/** What a run was bound to, or nothing for the instance
 * default on both halves. */
export type ProviderChoice = { model?: string; effort?: string };

/** Resolve the configured provider, or null when the assistant is absent.
 * A run's bound choice decides the identity and the effort; with none, the
 * instance default answers exactly as it did before the choice existed. */
export function createProvider(
  choice: ProviderChoice = {},
  env: Record<string, string | undefined> = process.env,
): ModelProvider | null {
  const availability = assistantAvailability(env);
  if (!availability.enabled) return null;
  const model = choice.model ?? availability.model;
  if (availability.provider === "anthropic") {
    return anthropicProvider(env.ANTHROPIC_API_KEY!, model, undefined, choice.effort);
  }
  return openaiProvider(env.OPENAI_API_KEY!, model, undefined, choice.effort);
}

/** The provider for a person's own key, on a client that takes nothing from
 * the server's environment: the provider's public address and that key alone.
 * Bound to the save it was built from, so it makes no request once that save is
 * gone, whoever removed it. */
export function createOwnKeyProvider(accountId: string, own: { provider: KeyProvider; key: string; save: string }, choice: { model: string; effort?: string }): ModelProvider {
  const provider = own.provider === "anthropic"
    ? anthropicProvider(own.key, choice.model, undefined, choice.effort, "own")
    : openaiProvider(own.key, choice.model, undefined, choice.effort, "own");
  return boundToSave(provider, accountId, own.save);
}
