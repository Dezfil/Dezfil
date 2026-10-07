import type { SettingDefinition } from "@/lib/settings/types";
import type { UnitControl, Value } from "./save-unit";

/**
 * A setting as the configuration read reports it: its definition (with
 * the default disclosed as the read discloses it) and how it resolved.
 */
export type ReadSetting = Omit<SettingDefinition, "defaultValue"> & {
  readonly defaultValue: unknown;
  readonly value: unknown;
  readonly source: "environment" | "stored" | "default";
  readonly locked: boolean;
  readonly invalidOverride: boolean;
  readonly storedValue: unknown;
};

/**
 * How a setting the page cannot change is drawn. Locked: the server's
 * environment pins it, by a value it uses, or by one it could not use
 * (the default applies then, and the value is never shown). Fixed: the
 * page offers no change at all; its variable, when it has one, changes it
 * at the next start.
 */
export type ServerSetState =
  | { readonly kind: "locked"; readonly variable: string; readonly invalid: boolean }
  | { readonly kind: "fixed"; readonly variable: string | null };

/** Null for a setting the page edits with its own control. */
export function serverSetState(setting: Pick<ReadSetting, "editable" | "locked" | "invalidOverride"> & { readonly environment?: string }): ServerSetState | null {
  if (setting.locked && setting.environment) return { kind: "locked", variable: setting.environment, invalid: setting.invalidOverride };
  if (!setting.editable || setting.locked) return { kind: "fixed", variable: setting.environment ?? null };
  return null;
}

const primitive = (value: unknown): value is Value =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The save unit's view of a setting: its key, how it saves, its range,
 * and its default for Reset. A pinned or fixed setting is locked, so it
 * joins neither Save, Reset nor the leave guard. A card with nothing to
 * return to (this instance's own name) passes `reset: false`. */
export function unitControlFor(setting: ReadSetting, options: { reset?: boolean } = {}): UnitControl {
  const locked = serverSetState(setting) !== null;
  const kind: UnitControl["kind"] = setting.kind === "number" ? "number" : setting.kind === "choice" || setting.kind === "boolean" ? "choice" : "text";
  const range = setting.write?.kind === "integer" ? { min: setting.write.min, max: setting.write.max } : {};
  const resettable = options.reset !== false && !locked && primitive(setting.defaultValue);
  return { key: setting.key, kind, ...range, locked, ...(resettable ? { defaultValue: setting.defaultValue as Value } : {}) };
}

/** A number as the page writes it: grouped, as the rest of the product does. */
export function formatSettingNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value) : String(value ?? "");
}
