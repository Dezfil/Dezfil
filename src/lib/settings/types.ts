/** Definitions contain data only. They must not initialize a reader or a store. */
export type SettingValue = number | boolean | string | null | readonly string[];
export type SettingDefault = SettingValue | { readonly rule: string };
export type WriteConstraint =
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  /** Any finite number within inclusive bounds, kept as given: never rounded. */
  | { readonly kind: "decimal"; readonly min: number; readonly max: number }
  /** True or false. */
  | { readonly kind: "switch" }
  | { readonly kind: "text"; readonly maxLength: number; readonly empty: "null" | "value" }
  | { readonly kind: "choice"; readonly values: readonly string[] };

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  readonly purpose: string;
  readonly scope: "instance" | "account" | "platform";
  /** Who reads the value: admins, its own account, every signed-in account, or anyone. */
  readonly readBy: "admin" | "account" | "signed-in" | "public";
  readonly changedBy: "deployment" | "admin" | "account" | "platform";
  readonly kind: "number" | "boolean" | "text" | "choice" | "list" | "address" | "path" | "secret";
  readonly defaultValue: SettingDefault;
  readonly documentedDefault: string;
  readonly environment?: string;
  readonly environmentTiming?: "restart";
  /** Timing of an application write, or next-start for deployment-only values. */
  readonly timing: "live" | "next-start";
  readonly secret: boolean;
  readonly editable: boolean;
  readonly write?: WriteConstraint;
  readonly unit?: string;
}

export type NumericParsing = "positive" | "non-negative" | "positive-integer";
export interface NumericDefinition extends SettingDefinition {
  readonly kind: "number";
  readonly defaultValue: number;
  readonly environment: string;
  readonly parsing: NumericParsing;
}
