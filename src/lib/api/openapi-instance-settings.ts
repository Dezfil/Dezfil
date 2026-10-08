import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { disclosedDefinition } from "@/lib/settings/disclosure";
import { isInstanceDefault } from "@/lib/settings/instance-defaults";
import type { SettingDefinition, WriteConstraint } from "@/lib/settings/types";
import { EXPORT_MAX_DIMENSION } from "@/lib/export/space";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const rule = object({ rule: { type: "string" } });
const address = { oneOf: [object({ set: { const: false } }), object({ set: { const: true }, origin: { type: "string", description: "Scheme and host only, including the port when set. No user information, path, query or fragment." } }),
  object({ set: { const: true }, unreadable: { const: true } }), rule] };

/** One site as the sites kind takes it: http or https, a host and an
 * optional port, an optional closing slash, nothing else. The server also
 * refuses a host a framing policy cannot name. */
const SITE = { type: "string", pattern: "^\\s*[Hh][Tt][Tt][Pp][Ss]?://[^/?#@\\\\\\s]+/?\\s*$" };
const sites = (constraint: Extract<WriteConstraint, { kind: "sites" }>) => ({ maxItems: constraint.maxSites, items: SITE });
/** A site as it is kept and read back: its scheme, lower-case host and any port. */
const KEPT_SITE = { type: "string", pattern: "^https?://[a-z0-9.-]+(?::[0-9]{1,5})?$" };

function valueSchema(definition: SettingDefinition): Record<string, unknown> {
  if (definition.secret) return definition.key === "secretKey"
    ? object({ status: { type: "string", enum: ["environment", "data-directory", "not-yet-present"] } })
    : object({ set: { type: "boolean" } });
  if (definition.kind === "address") return address;
  const value = definition.write?.kind === "sites" ? { type: "array", maxItems: definition.write.maxSites, items: KEPT_SITE }
    : definition.kind === "number" ? { type: "number" } : definition.kind === "boolean" ? { type: "boolean" }
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

/** What new things start with, as the runtime configuration reports them:
 * the settings every signed-in account reads, keyed and valued as the
 * change operation takes them, every key present. */
export const INSTANCE_DEFAULTS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: SETTING_CATALOGUE.filter(isInstanceDefault).map(definition => definition.key),
  description: "What new things start with on this instance, keyed and valued as PATCH /api/instance/settings takes them: every key " +
    "with its effective value. A new map takes the newMap values and a new layer created without a style the newLayer values; " +
    "the workflow canvas, the SQL console and a fresh image export card take theirs as they open. Admins change them, and " +
    "nothing that already exists changes with them. A basemap the instance no longer offers reads as auto.",
  properties: Object.fromEntries(SETTING_CATALOGUE.filter(isInstanceDefault).map(definition => {
    const constraint = definition.write!;
    const value = constraint.kind === "integer" ? { type: "integer", minimum: constraint.min, maximum: constraint.max }
      : constraint.kind === "decimal" ? { type: "number", minimum: constraint.min, maximum: constraint.max }
      : constraint.kind === "switch" ? { type: "boolean" }
      : constraint.kind === "text" ? { type: "string", maxLength: constraint.maxLength }
      : constraint.kind === "sites" ? { type: "array", ...sites(constraint) }
      : { type: "string", enum: [...constraint.values] };
    return [definition.key, { ...value, description: `${definition.label}${definition.unit ? ` (${definition.unit})` : ""}. ${definition.purpose}` }];
  })),
};

export const INSTANCE_SETTINGS_SCHEMAS = {
  InstanceSettingsPatch: {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(SETTING_CATALOGUE.filter(d => d.scope === "instance" && d.editable).map(definition => {
      const constraint = definition.write!;
      const schema = constraint.kind === "integer" ? { type: ["integer", "null"], minimum: constraint.min, maximum: constraint.max }
        : constraint.kind === "decimal" ? { type: ["number", "null"], minimum: constraint.min, maximum: constraint.max }
        : constraint.kind === "switch" ? { type: ["boolean", "null"] }
        : constraint.kind === "text" ? { type: ["string", "null"], pattern: `^\\s*[\\s\\S]{0,${constraint.maxLength}}\\s*$` }
        : constraint.kind === "sites" ? { type: ["array", "null"], ...sites(constraint) }
        : { type: ["string", "null"], enum: [...constraint.values, null] };
      const note = constraint.kind === "text" ? `Text is trimmed before the ${constraint.maxLength}-character limit; empty text clears to the default.`
        : constraint.kind === "sites" ? `At most ${constraint.maxSites} sites, each http or https with a host and an optional port and nothing else. ` +
          "Each is kept as its scheme, host and port, a repeated site once; an empty list clears to the default." : "";
      return [definition.key, { ...schema, description: `${definition.label}. ${definition.purpose} Null clears the stored value. ${note}`.trim() }];
    })),
  },
  InstanceSettings: object({ settings: object(settings),
    capacities: object({ geocodeRows: { type: "integer", minimum: 1 }, isochroneOrigins: { type: "integer", minimum: 0 } }),
    maxImageDimension: { type: "integer", const: EXPORT_MAX_DIMENSION }, version: { type: "string" }, startedAt: { type: "string", format: "date-time" },
    warnings: { type: "array", items: { type: "string" }, description: "Effective timeout relationship mismatches, including deployment overrides. These do not block unrelated edits." },
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
      "Address value and defaultValue expose scheme and host only, never user information, paths, queries or fragments; malformed addresses report set and unreadable. " +
      "The built-in documentedDefault stays as documented, including any path. " +
      "Contextual defaults carry a rule when there is no single address or value. The read generates no key, writes no configuration file, " +
      "contacts no service and initializes no engine. Capacities report admitted geocode rows and travel-time origins per run, " +
      "without promising a configured provider. Also returns the fixed maximum image dimension, package version, stable process start time " +
      "and warnings when the effective query timeout is at or above the run timeout.",
    tag: "System", tool: "get_instance_settings", toolInput: { closed: true }, display: { verb: "Read instance configuration" }, effects: READ_ONLY, mcp: LOCAL_READ,
    responses: { "200": jsonOk("#/components/schemas/InstanceSettings"), "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY }, patch: { ...op({
    summary: "Change instance settings",
    description: "Requires a current admin through cookie or bearer authentication, rechecked inside the write transaction on every call. " +
      "Cookie mutations require the same trusted Origin; an admin bearer token calls directly with no additional scope or approval step. " +
      "Responses, including refusals, are private, no-store. Submit only editable keys; omitted keys stay unchanged and null clears a stored value. " +
      "The complete body is validated against the committed configuration under one write lock. A refusal or failed commit changes nothing. " +
      "Non-editable keys answer 400 invalid_request as read-only regardless of their environment. " +
      "A non-empty environment variable locks an editable setting, including invalid overrides and null writes. A locked editable key answers 409 setting_locked, " +
      "taking precedence over 400 invalid_request for unknown, non-editable, wrong-kind, non-whole, out-of-range, over-length or invalid-choice entries, " +
      "a site list entry that is not http or https with a host and an optional port, a resulting queryTimeoutS at or above operationTimeoutS, " +
      "a resulting security.failedPerAddress below security.failedPerAccount, and a resulting publishing.embedding of listed with no publishing.embedSites. " +
      "Messages identify all failing known keys and their reasons, unknown keys by their entry position and a refused site by its position, " +
      "without echoing arbitrary input. The sign-in counts, and embedding with its sites, are checked when a body changes either side. " +
      "An existing environment timeout mismatch is reported in warnings and blocks no unrelated change. " +
      "Concurrent different-key edits both land; the last accepted value wins on one key. There is no stale-write rejection or Undo. " +
      "Stored changes apply live to new work; admitted work keeps its budget. Lowered concurrency cancels nothing, increased concurrency wakes waiters " +
      "after commit, and lowered queue limits keep accepted waiters. Public limits apply against the existing window count. Environment changes need a restart. " +
      "Returns the same configuration as the read, with the same secret and address disclosure rules; no secret or address setting is accepted. " +
      "The embedded assistant asks for confirmation before calling on pages admitting writes; SQL and workflow assistants refuse this update. " +
      "MCP advertises that policy and adds no confirmation step.",
    tag: "System", tool: "update_instance_settings", toolInput: { closed: true }, display: { verb: "Changed instance settings" },
    effects: writes(resource("settings")), mcp: LOCAL_REPLACE, confirm: true,
    confirmation: { target: "Change instance settings?", consequence: "These settings apply to the whole instance. Limits affect new work; admitted work keeps its budget. There is no Undo.",
      subject: { path: null, argument: "", name: "" } },
    requestBody: { required: true, "x-byte-limit": 65_536, content: { "application/json": { schema: { $ref: "#/components/schemas/InstanceSettingsPatch" }, example: { previewRows: 2000, queryTimeoutS: 90 } } } },
    responses: { "200": jsonOk("#/components/schemas/InstanceSettings"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE,
      "409": ERROR_RESPONSE, "413": ERROR_RESPONSE, "500": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
};
