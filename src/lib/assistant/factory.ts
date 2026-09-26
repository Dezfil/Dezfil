import { assistantAvailability } from "./config";
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
