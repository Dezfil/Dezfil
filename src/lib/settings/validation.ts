import type { SettingDefinition, SettingValue } from "./types";

type Validation = { ok: true; value: SettingValue } | { ok: false; reason: string };

/** Kind and range only. Locking, authority and cross-setting rules belong to the writer. */
export function validateStoredValue(definition: SettingDefinition, input: unknown): Validation {
  const constraint = definition.write;
  if (!definition.editable || !constraint) return { ok: false, reason: "Setting is read-only." };
  if (input === null && definition.scope === "instance") return { ok: true, value: null };
  switch (constraint.kind) {
    case "integer":
      return typeof input === "number" && Number.isInteger(input) && input >= constraint.min && input <= constraint.max
        ? { ok: true, value: input } : { ok: false, reason: `Expected a whole number from ${constraint.min} to ${constraint.max}.` };
    case "text": {
      if (typeof input !== "string") return { ok: false, reason: "Expected text." };
      const value = input.trim();
      return value.length <= constraint.maxLength
        ? { ok: true, value: value || (constraint.empty === "null" ? null : "") }
        : { ok: false, reason: `Expected at most ${constraint.maxLength} characters.` };
    }
    case "choice":
      return typeof input === "string" && constraint.values.includes(input)
        ? { ok: true, value: input } : { ok: false, reason: `Expected one of: ${constraint.values.join(", ")}.` };
  }
}

export function catalogueProblems(definitions: readonly SettingDefinition[]): string[] {
  const problems: string[] = [], keys = new Set<string>(), variables = new Set<string>();
  for (const definition of definitions) {
    const { key, environment, write } = definition;
    const report = (reason: string) => problems.push(`${key}: ${reason}`);
    if (keys.has(key)) report("duplicate key");
    keys.add(key);
    if (environment && variables.has(environment)) report("duplicate variable");
    if (environment) variables.add(environment);
    if (!key || !definition.label || !definition.purpose || !definition.documentedDefault) report("incomplete definition");
    if (environment && definition.environmentTiming !== "restart") report("environment changes require restart");
    if (definition.scope === "account" && environment) report("account variable");
    if (definition.editable && definition.timing !== "live") report("editable next-start");
    if (definition.editable && (definition.secret || definition.kind === "secret")) report("editable secret");
    if (definition.editable && !write) report("missing validator");
    if (!definition.editable && write) report("read-only write constraint");
    if (write?.kind === "integer" && (definition.kind !== "number" || !Number.isSafeInteger(write.min) || !Number.isSafeInteger(write.max) || write.min > write.max)) report("invalid integer constraint");
    if (write?.kind === "text" && (definition.kind !== "text" || !Number.isSafeInteger(write.maxLength) || write.maxLength < 1)) report("invalid text constraint");
    if (write?.kind === "choice" && (definition.kind !== "choice" || !write.values.length || new Set(write.values).size !== write.values.length)) report("invalid choice constraint");
    if (definition.editable && !validateStoredValue(definition, definition.defaultValue).ok) report("default fails validation");
  }
  return problems;
}
