import { analyticalGuidance } from "./guidance";
import { corePrompt } from "./core-prompt";

/**
 * The assistant's system prompt, composed of the core prompt
 * (core-prompt.ts, the text as it stood before the guidance) and the
 * analytical guidance, whose one production source is guidance.ts.
 */
export function systemPrompt(): string {
  return `${corePrompt()}\n\n${analyticalGuidance()}`;
}

export { corePrompt };
