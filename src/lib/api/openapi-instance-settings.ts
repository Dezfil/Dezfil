import { SETTING_CATALOGUE } from "@/lib/settings/catalogue";
import { disclosedDefinition, refusesUserInformation, variableMayNameFolder } from "@/lib/settings/disclosure";
import { isInstanceDefault } from "@/lib/settings/instance-defaults";
import type { SettingDefinition, WriteConstraint } from "@/lib/settings/types";
import { EXPORT_MAX_DIMENSION } from "@/lib/export/space";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { SERVICE_FACTS_SCHEMA } from "./openapi-instance-services";
import { PART_STATES_SCHEMA } from "./openapi-instance-system";
import { LIBRARY_STYLES_SCHEMA } from "./openapi-instance-basemaps";

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const rule = object({ rule: { type: "string" } });
const ORIGIN = { type: "string", description: "Scheme and host only, including the port when set. No user information, path, query or fragment." };
const address = { oneOf: [object({ set: { const: false } }), object({ set: { const: true }, origin: ORIGIN }),
  object({ set: { const: true }, unreadable: { const: true } }), rule] };
/** A tile template browsers load also says when the one in effect carries user information. */
const template = { oneOf: [...address.oneOf.slice(0, 2), object({ set: { const: true }, origin: ORIGIN,
  userInformation: { const: true, description: "The template in effect carries a user name or password, never given here. No browser loads tiles from such an address, so the imagery is not drawn." } }),
  ...address.oneOf.slice(2)] };

/** An address whose variable may name a folder on the server instead (the
 * template catalogue's) also reads as a folder, never which. */
const folderAddress = { oneOf: [...address.oneOf.slice(0, 3), object({ set: { const: true },
  folder: { const: true, description: "The variable names a folder on this server, read as files under the same checks; its path is never given." } }),
  ...address.oneOf.slice(3)] };

/** One site as the sites kind takes it: http or https, a host and an
 * optional port, an optional closing slash, nothing else. The server also
 * refuses a host a framing policy cannot name. */
const SITE = { type: "string", pattern: "^\\s*[Hh][Tt][Tt][Pp][Ss]?://[^/?#@\\\\\\s]+/?\\s*$" };
const sites = (constraint: Extract<WriteConstraint, { kind: "sites" }>) => ({ maxItems: constraint.maxSites, items: SITE });
/** A site as it is kept and read back: its scheme, lower-case host and any port. */
const KEPT_SITE = { type: "string", pattern: "^https?://[a-z0-9.-]+(?::[0-9]{1,5})?$" };
/** A service's address as the address kind takes it: http or https with a
 * host right after its two slashes; the server also parses it and holds
 * the length once trimmed. */
const ADDRESS = { pattern: "^\\s*[Hh][Tt][Tt][Pp][Ss]?://[^/\\\\?#\\s]" };

function valueSchema(definition: SettingDefinition): Record<string, unknown> {
  if (definition.secret) return definition.key === "secretKey"
    ? object({ status: { type: "string", enum: ["environment", "data-directory", "not-yet-present"] } })
    : object({ set: { type: "boolean" } });
  if (definition.kind === "address") return refusesUserInformation(definition) ? template : variableMayNameFolder(definition) ? folderAddress : address;
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
    // An address is write-only: what was stored is never read back, only disclosed in value.
    storedValue: definition.editable && definition.write?.kind !== "address" ? { anyOf: [valueSchema(definition), { type: "null" }] } : { type: "null" },
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
      : constraint.kind === "address" ? { type: "string", ...ADDRESS }
      : { type: "string", enum: [...constraint.values] };
    return [definition.key, { ...value, description: `${definition.label}${definition.unit ? ` (${definition.unit})` : ""}. ${definition.purpose}` }];
  })),
};

/** The rules every signed-in account's screens follow, as the runtime read
 * reports them: keyed and valued as the change operation takes them, every
 * key present. */
export function instanceRulesSchema(keys: readonly string[]) {
  const definitions = SETTING_CATALOGUE.filter(definition => keys.includes(definition.key));
  return {
    type: "object", additionalProperties: false, required: definitions.map(definition => definition.key),
    description: "The rules every signed-in account follows, keyed and valued as PATCH /api/instance/settings takes them. Admins change them.",
    properties: Object.fromEntries(definitions.map(definition => [definition.key, {
      type: "string", enum: [...(definition.write as Extract<WriteConstraint, { kind: "choice" }>).values], description: definition.purpose,
    }])),
  };
}

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
        : constraint.kind === "address" ? { type: ["string", "null"], ...ADDRESS }
        : { type: ["string", "null"], enum: [...constraint.values, null] };
      const note = constraint.kind === "text" ? `Text is trimmed before the ${constraint.maxLength}-character limit; empty text clears to the default.` +
          (definition.environment ? ` A set ${definition.environment} locks it.` : "")
        : constraint.kind === "sites" ? `At most ${constraint.maxSites} sites, each http or https with a host and an optional port and nothing else. ` +
          "Each is kept as its scheme, host and port, a repeated site once; an empty list clears to the default."
        : constraint.kind === "address" ? `An http or https address with a host, at most ${constraint.maxLength} characters once trimmed, kept as given. ` +
          (constraint.placeholders ? `It must hold ${constraint.placeholders.join(", ")}; the save-time check reads it with each filled with a digit. ` : "") +
          (constraint.userInformation === "refused" ? "It must carry no user name or password: a browser cannot load tiles from such an address, " +
            "so the key belongs in the path or the query. " : "") +
          "Write-only: it is stored encrypted with the instance's key and every read gives back its scheme and host alone, so a new key " +
          `means sending the whole address again. A set ${definition.environment} locks it.` +
          (constraint.folder === "variable" ? ` Only ${definition.environment} may name a folder on the server instead; a folder is never taken here.` : "") : "";
      return [definition.key, { ...schema, description: `${definition.label}. ${definition.purpose} Null clears the stored value. ${note}`.trim() }];
    })),
  },
  InstanceSettings: object({ settings: object(settings),
    capacities: object({ geocodeRows: { type: "integer", minimum: 1 }, isochroneOrigins: { type: "integer", minimum: 0 } }),
    maxImageDimension: { type: "integer", const: EXPORT_MAX_DIMENSION }, version: { type: "string" }, startedAt: { type: "string", format: "date-time" },
    warnings: { type: "array", items: { type: "string" }, description: "Effective timeout relationship mismatches, including deployment overrides. These do not block unrelated edits." },
    parts: PART_STATES_SCHEMA,
    basemapStyles: LIBRARY_STYLES_SCHEMA,
    services: SERVICE_FACTS_SCHEMA,
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
      "A service address or the satellite tile template an admin stored reads as set with its scheme and host, or as set and unreadable once the instance's " +
      "encryption key no longer opens it; its storedValue is always null. The satellite tile template in effect, stored or set by DEZFIL_SATELLITE_URL, " +
      "also reads with userInformation true while it carries a user name or password, which is never given: no browser loads tiles from such an address, " +
      "so the imagery is not drawn. The satellite credit an admin stored reads as stored while DEZFIL_SATELLITE_ATTRIBUTION " +
      "is unset, and as the variable's, with the stored credit as storedValue, while it is set. " +
      "The template catalogue's address (templatesCatalogueUrl) reads as a service address does; while DEZFIL_TEMPLATES_CATALOGUE names a folder on this " +
      "server instead of an http or https address, it reads as set with folder true, and the folder's path is never given. " +
      "Trusted engine memory (trustedMemoryMb) defaults to 3072 MB and Bytes drawn per layer (renderCapBytes) to 134217728 bytes; both are deployment-controlled and reject writes. " +
      "Data processing time limit (dataProcessingTimeoutS) defaults to 3600 seconds, accepts stored whole seconds from 60 to 21600, and resets with null. " +
      "Trusted imports, refreshes, geometry and sketch changes, template installation and export conversion use the Data processing time limit. Trusted work shares the configured memory budget and a dedicated scratch allowance of four times that value; restart clears abandoned spill. Exhaustion answers engine_memory_exceeded, naming memory or scratch and DEZFIL_TRUSTED_MEMORY_MB. Upload reception and processing each use the value admitted when reception begins, with separate deadlines. Layer renders and dataset map features count their complete inline answer against Bytes drawn per layer as it is built; above it a layer takes its tile road or answers the errored layer render_bytes_exceeded, and dataset map features answer ok:false with a reason. Slider, Overture and OpenStreetMap previews count theirs too and answer 422 render_bytes_exceeded above it. Sketch features do not apply it yet. " +
      "The built-in documentedDefault stays as documented, including any path. " +
      "Contextual defaults carry a rule when there is no single address or value. The read generates no key, writes no configuration file, " +
      "contacts no service and initializes no engine. Capacities report admitted geocode rows and travel-time origins per run, " +
      "without promising a configured provider. Also returns the fixed maximum image dimension, package version, stable process start time " +
      "and warnings when the effective query timeout is at or above the run timeout. " +
      "Services report each provider cache (geocode, isochrone, overpass) with the bytes its answers take, how many it holds and its budget in MB, " +
      "and the Overture release list this process keeps: how many releases, the newest and when it was listed, or not listed yet. " +
      "Parts report each part of this server, starting nothing and running no program: the query engine's library version, whether the engine " +
      "has started and the extensions it loaded; whether the tile builder and the image renderer's browser are executable files where their " +
      "settings point, by a file check, the tile builder's version once this server has run it, and Images at once; the metadata database's file name. " +
      "basemapStyles is the basemap library, oldest first, hidden styles included: each style's id, name, address, credit, whether it is offered and when it was added.",
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
      "Returns the same configuration as the read, with the same secret and address disclosure rules. No secret is accepted. " +
      "The four service addresses (geocoderUrl, isochroneUrl, overpassUrl, s3Endpoint), the satellite imagery's tile template (satelliteUrl) and the " +
      "template catalogue's address (templatesCatalogueUrl) are write-only: " +
      "each is stored encrypted and read back as its scheme and host alone; a refusal names the key and never repeats the address. " +
      "The catalogue's address is http or https here: a folder on the server is named by DEZFIL_TEMPLATES_CATALOGUE alone. " +
      "The template must also hold {z}, {x} and {y}, a refusal naming the ones missing, and carry no user name or password, refused " +
      "before any lookup with a sentence saying a browser cannot load tiles from such an address and the key belongs in the path or the query. Before the write, an address is also refused " +
      "(400 invalid_request, with the egress policy's own sentence) when that policy would refuse a request to it now, a template with each placeholder " +
      "filled with a digit: a literal in loopback, private, carrier-grade, link-local or metadata, unique-local, unspecified, multicast or reserved space, " +
      "mapped and NAT64 forms included, or a name all of whose addresses resolve there, unless DEZFIL_EGRESS_ALLOWLIST names it. " +
      "A name that does not resolve at save is kept; every request to the address is checked again. " +
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
