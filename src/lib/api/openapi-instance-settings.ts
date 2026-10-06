import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { disclosedDefinition } from "@/lib/settings/disclosure";
import type { SettingDefinition } from "@/lib/settings/types";
import { EXPORT_MAX_DIMENSION } from "@/lib/export/space";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_READ } from "./operation-mcp";
import { READ_ONLY } from "./operation-metadata";

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const rule = object({ rule: { type: "string" } });
const address = { oneOf: [object({ set: { const: false } }), object({ set: { const: true }, origin: { type: "string", description: "Scheme and host only, including the port when set. No user information, path, query or fragment." } }),
  object({ set: { const: true }, unreadable: { const: true } }), rule] };

function valueSchema(definition: SettingDefinition): Record<string, unknown> {
  if (definition.secret) return definition.key === "secretKey"
    ? object({ status: { type: "string", enum: ["environment", "data-directory", "not-yet-present"] } })
    : object({ set: { type: "boolean" } });
  if (definition.kind === "address") return address;
  const value = definition.kind === "number" ? { type: "number" } : definition.kind === "boolean" ? { type: "boolean" }
    : definition.kind === "list" ? { type: "array", items: { type: "string" } } : { type: ["string", "null"] };
  return { anyOf: [value, rule] };
}

const settings = Object.fromEntries(SETTING_CATALOGUE.filter(d => d.scope !== "account").map(definition => {
  const fields = Object.fromEntries(Object.entries(disclosedDefinition(definition)).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, { const: value }]));
  return [definition.key, object({ ...fields, value: valueSchema(definition),
    source: { type: "string", enum: ["environment", "stored", "default"] }, locked: { type: "boolean" }, invalidOverride: { type: "boolean" },
    storedValue: definition.editable ? { anyOf: [valueSchema(definition), { type: "null" }] } : { type: "null" },
  })];
}));

export const INSTANCE_SETTINGS_SCHEMAS = {
  InstanceSettings: object({ settings: object(settings),
    capacities: object({ geocodeRows: { type: "integer", minimum: 1 }, isochroneOrigins: { type: "integer", minimum: 0 } }),
    maxImageDimension: { type: "integer", const: EXPORT_MAX_DIMENSION }, version: { type: "string" }, startedAt: { type: "string", format: "date-time" },
  }),
};

export const INSTANCE_SETTINGS_PATHS = {
  "/api/instance/settings": { get: { ...op({
    summary: "Read instance configuration",
    description: "Requires a current admin account through a cookie session or bearer token, rechecked on every call. " +
      "Responses, including refusals, are private, no-store. Returns every instance and platform definition with its effective value, " +
      "source, stored value (including a shadowed value), lock and invalid-override state. A non-empty environment variable locks " +
      "the setting even when invalid; invalid numeric overrides use the default without returning the override text. " +
      "Empty numeric overrides are absent; a set empty assistant model list retains its default model alone. Environment changes require a restart. " +
      "Provider keys report set or not set; the encryption key reports environment, data-directory or not-yet-present. " +
      "Addresses expose scheme and host only, never user information, paths, queries or fragments; malformed addresses report set and unreadable. " +
      "Contextual defaults carry a rule when there is no single address or value. The read generates no key, writes no configuration file, " +
      "contacts no service and initializes no engine. Capacities report admitted geocode rows and travel-time origins per run, " +
      "without promising a configured provider. Also returns the fixed maximum image dimension, package version and stable process start time.",
    tag: "System", tool: "get_instance_settings", toolInput: { closed: true }, display: { verb: "Read instance configuration" }, effects: READ_ONLY, mcp: LOCAL_READ,
    responses: { "200": jsonOk("#/components/schemas/InstanceSettings"), "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
};
