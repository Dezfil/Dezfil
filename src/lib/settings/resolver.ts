import { settingDefinition } from "./catalogue";
import { NUMERIC_SETTINGS, type NumericSettingKey } from "./numeric";
import { committedNumericSettings } from "./state";
import type { SettingDefinition } from "./types";

export function lockedEnvironment(definition: SettingDefinition): string | undefined {
  const raw = definition.environment ? process.env[definition.environment] : undefined;
  return raw !== undefined && raw !== "" ? definition.environment : undefined;
}

export interface ResolvedSetting<T> {
  key: string;
  value: T;
  source: "environment" | "stored" | "default";
  locked: boolean;
  invalidOverride: boolean;
  storedValue: T | null;
}

export interface NumericResolutionInput {
  environment?: Readonly<Record<string, string | undefined>>;
  /** A caller-owned, validated snapshot. Resolving never opens or writes a store. */
  stored?: Readonly<Partial<Record<NumericSettingKey, number | null>>>;
}

/** Reporting uses the same numeric resolution over one caller-owned store snapshot. */
export function resolveNumericSettings(input: NumericResolutionInput): Record<string, ResolvedSetting<number>> {
  return Object.fromEntries(NUMERIC_SETTINGS.map(({ key }) => [key, resolveNumericSetting(key, input)]));
}

export function settingEnvironment(definition: SettingDefinition): string | undefined {
  return definition.environment ? process.env[definition.environment] : undefined;
}

const numericByKey = new Map(NUMERIC_SETTINGS.map(definition => [definition.key, definition]));

/** Environment changes require a deployment restart. Read on each call rather than
 * caching a second copy of the process environment. App write bounds do not narrow it. */
export function resolveNumericSetting(key: NumericSettingKey, input: NumericResolutionInput = {}): ResolvedSetting<number> {
  const definition = numericByKey.get(key);
  if (!definition) throw new Error(`Unknown numeric setting: ${key}`);
  const raw = (input.environment ?? process.env)[definition.environment];
  const storedValue = definition.editable ? (input.stored ?? committedNumericSettings())[key] ?? null : null;
  const locked = raw !== undefined && raw !== "";
  if (locked) {
    const number = Number(raw);
    const accepted = Number.isFinite(number) && (definition.parsing === "non-negative" ? number >= 0 : number > 0);
    const value = accepted
      ? definition.parsing === "positive-integer" ? Math.max(1, Math.floor(number)) : number
      : definition.defaultValue;
    return { key, value, source: accepted ? "environment" : "default", locked: true, invalidOverride: !accepted, storedValue };
  }
  return { key, value: storedValue ?? definition.defaultValue, source: storedValue === null ? "default" : "stored",
    locked: false, invalidOverride: false, storedValue };
}

/** Synchronous consumer boundary, in the catalogue's deployment units. */
export function resolveNumber(key: NumericSettingKey): number {
  return resolveNumericSetting(key).value;
}

export function resolveBoolean(key: "assistantAutoCheck"): boolean {
  const definition = settingDefinition(key);
  const configured = process.env[definition.environment!];
  if (configured === undefined || configured === "") return definition.defaultValue as boolean;
  const raw = configured.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}
