import { expect } from "vitest";

/** Expected user-facing wording, independent of the production sentence builder. */
export function expectSettingRemedy(message: string, label: string, variable: string, locked: boolean): void {
  const sentence = locked ? `Change ${variable} and restart to change "${label}".` : `An admin can change "${label}".`;
  expect(message).toContain(sentence);
  if (!locked) expect(message).not.toContain(variable);
  expect(message).not.toMatch(/settings page|Settings >|Settings →/);
}
