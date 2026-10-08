import { INSTANCE_RULE_GROUPS } from "./instance-security";
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
    case "decimal":
      return typeof input === "number" && Number.isFinite(input) && input >= constraint.min && input <= constraint.max
        ? { ok: true, value: input } : { ok: false, reason: `Expected a number from ${constraint.min} to ${constraint.max}.` };
    case "switch":
      return typeof input === "boolean" ? { ok: true, value: input } : { ok: false, reason: "Expected true or false." };
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
    case "sites": {
      if (!Array.isArray(input) || input.length > constraint.maxSites) return { ok: false, reason: `Expected a list of at most ${constraint.maxSites} sites.` };
      const origins: string[] = [];
      for (const [index, entry] of input.entries()) {
        // Named by position: an entry may hold a credential, so it is never repeated.
        const origin = typeof entry === "string" ? siteOrigin(entry) : null;
        if (origin === null) return { ok: false, reason: `Expected each site as http or https with a host and an optional port, nothing else; entry ${index + 1} is not.` };
        if (!origins.includes(origin)) origins.push(origin);
      }
      return { ok: true, value: origins.length ? origins : null };
    }
  }
}

/** A site as its scheme, host and port, or null for anything more or less:
 * user information, a path past the bare closing slash, a query or a
 * fragment, or a host a framing policy cannot name exactly. A host is
 * dot-separated labels of letters, digits and hyphens (an IPv4 address
 * included), so no site can carry a separator into the policy. The
 * scheme's own port is dropped, as the browser drops it. */
function siteOrigin(entry: string): string | null {
  const text = entry.trim();
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (!/^(?=.{1,253}$)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*$/.test(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
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
    // Every signed-in account reads these: no deployment pins one, and none is a secret.
    if (definition.readBy === "signed-in" && environment) report("signed-in variable");
    if (definition.readBy === "signed-in" && (definition.secret || definition.kind === "secret")) report("signed-in secret");
    // How long sign-ins and links last, when sign-in pauses, and who may
    // create tokens, publish, embed, connect or import: the admin's to
    // change, so no deployment pins one.
    if (environment && (INSTANCE_RULE_GROUPS as readonly string[]).includes(key.split(".")[0])) report("security variable");
    if (definition.editable && definition.timing !== "live") report("editable next-start");
    if (definition.editable && (definition.secret || definition.kind === "secret")) report("editable secret");
    if (definition.editable && !write) report("missing validator");
    if (!definition.editable && write) report("read-only write constraint");
    if (write?.kind === "integer" && (definition.kind !== "number" || !Number.isSafeInteger(write.min) || !Number.isSafeInteger(write.max) || write.min > write.max)) report("invalid integer constraint");
    if (write?.kind === "decimal" && (definition.kind !== "number" || !Number.isFinite(write.min) || !Number.isFinite(write.max) || write.min > write.max)) report("invalid decimal constraint");
    if (write?.kind === "switch" && definition.kind !== "boolean") report("invalid switch constraint");
    if (write?.kind === "text" && (definition.kind !== "text" || !Number.isSafeInteger(write.maxLength) || write.maxLength < 1)) report("invalid text constraint");
    if (write?.kind === "choice" && (definition.kind !== "choice" || !write.values.length || new Set(write.values).size !== write.values.length)) report("invalid choice constraint");
    if (write?.kind === "sites" && (definition.kind !== "list" || !Number.isSafeInteger(write.maxSites) || write.maxSites < 1)) report("invalid sites constraint");
    if (definition.editable && !validateStoredValue(definition, definition.defaultValue).ok) report("default fails validation");
  }
  return problems;
}
