import { NUMERIC_SETTINGS } from "./numeric";
import { INSTANCE_DEFAULT_SETTINGS } from "./instance-defaults";
import { INSTANCE_SECURITY_SETTINGS } from "./instance-security";
import type { SettingDefault, SettingDefinition, WriteConstraint } from "./types";

/** Which settings are what new things start with, and which are the rules
 * every account follows, for a reader of the catalogue alone. */
export { isInstanceDefault } from "./instance-defaults";
export { isInstanceRule } from "./instance-security";

function deployment(key: string, environment: string, kind: SettingDefinition["kind"],
  label: string, purpose: string, defaultValue: SettingDefault, documentedDefault: string): SettingDefinition {
  return { key, environment, kind, label, purpose, defaultValue, documentedDefault,
    scope: "instance", readBy: "admin", changedBy: "deployment", environmentTiming: "restart",
    timing: "next-start", secret: kind === "secret", editable: false };
}
function stored(key: string, label: string, purpose: string, defaultValue: SettingDefault,
  write: WriteConstraint, scope: "instance" | "account" = "instance"): SettingDefinition {
  return { key, label, purpose, defaultValue, documentedDefault: defaultValue === null ? "unset" : defaultValue === "" ? "empty" : String(defaultValue),
    scope, readBy: scope === "account" ? "account" : "public", changedBy: scope === "account" ? "account" : "admin",
    kind: write.kind === "choice" ? "choice" : "text", timing: "live", secret: false, editable: true, write };
}
const choice = (...values: string[]): WriteConstraint => ({ kind: "choice", values });
/** A service's address, set by its variable or stored by an admin beside
 * it: a set variable locks it. Write-only, like the rest of the address
 * kind: what any read gives back is its scheme and host. */
function serviceAddress(key: string, environment: string, label: string, purpose: string,
  defaultValue: SettingDefault, documentedDefault: string): SettingDefinition {
  return { ...deployment(key, environment, "address", label, purpose, defaultValue, documentedDefault),
    changedBy: "admin", timing: "live", editable: true, write: { kind: "address", maxLength: 2048 } };
}

export const SETTING_CATALOGUE: readonly SettingDefinition[] = [
  ...NUMERIC_SETTINGS,
  deployment("assistantAutoCheck", "DEZFIL_ASSISTANT_AUTO_CHECK", "boolean", "Automatic map check", "Check the rendered map after an assistant turn changes it.", true, "on"),
  deployment("dataDir", "DEZFIL_DATA_DIR", "path", "Data directory", "The single durable directory for tables, tiles and metadata.", { rule: "working-directory/data" }, "./data; /data in the container"),
  deployment("secretKey", "DEZFIL_SECRET_KEY", "secret", "Encryption key", "At-rest encryption key for stored credentials.", { rule: "key-file-or-generate" }, "generated"),
  deployment("trustedProxies", "DEZFIL_TRUSTED_PROXIES", "list", "Trusted proxies", "Socket peers allowed to supply forwarding information.", [], "unset"),
  deployment("egressAllowlist", "DEZFIL_EGRESS_ALLOWLIST", "list", "Allowed destinations", "Hosts, IPs or CIDRs permitted past the egress policy.", [], "unset"),
  deployment("objectStoreCredentials", "DEZFIL_OBJECT_STORE_CREDENTIALS", "boolean", "Object-store credentials", "Sign imports with the instance credential chain when enabled.", false, "off"),
  serviceAddress("s3Endpoint", "DEZFIL_S3_ENDPOINT", "S3 endpoint", "Custom S3-compatible endpoint for anonymous imports.", { rule: "aws-bucket-endpoint" }, "AWS"),
  serviceAddress("overpassUrl", "DEZFIL_OVERPASS_URL", "Overpass endpoint", "Endpoint for OpenStreetMap imports.", "https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter"),
  deployment("overtureS3Endpoint", "DEZFIL_OVERTURE_S3_ENDPOINT", "address", "Overture endpoint", "S3-compatible override for the public Overture bucket.", null, "unset, the public bucket"),
  deployment("tippecanoe", "DEZFIL_TIPPECANOE", "path", "Tile builder", "Binary used to build vector tiles.", "tippecanoe", "tippecanoe"),
  deployment("basemapUrl", "DEZFIL_BASEMAP_URL", "address", "Basemap address", "Style override pinning the automatic basemap in both themes.", { rule: "built-in-basemap-for-theme" }, "built-in styles"),
  deployment("basemapAttribution", "DEZFIL_BASEMAP_ATTRIBUTION", "text", "Basemap credit", "Credit line for the deployment basemap override.", null, "unset"),
  deployment("satelliteUrl", "DEZFIL_SATELLITE_URL", "address", "Satellite template", "Raster tile template enabling satellite imagery.", null, "unset"),
  deployment("satelliteAttribution", "DEZFIL_SATELLITE_ATTRIBUTION", "text", "Satellite credit", "Credit line required by the imagery provider.", null, "unset"),
  serviceAddress("geocoderUrl", "DEZFIL_GEOCODER_URL", "Address finder", "Nominatim-compatible endpoint for search and batch geocoding.", null, "unset"),
  serviceAddress("isochroneUrl", "DEZFIL_ISOCHRONE_URL", "Travel-time endpoint", "Valhalla-compatible endpoint for travel-time areas.", null, "unset"),
  deployment("anthropicApiKey", "ANTHROPIC_API_KEY", "secret", "Anthropic credential", "Enables the assistant with this provider.", null, "unset"),
  deployment("openaiApiKey", "OPENAI_API_KEY", "secret", "OpenAI credential", "Enables the assistant with this provider.", null, "unset"),
  deployment("aiProvider", "DEZFIL_AI_PROVIDER", "choice", "Assistant provider", "Selects the provider when more than one credential is present.", { rule: "first-provider-with-key" }, "first key set"),
  deployment("aiModel", "DEZFIL_AI_MODEL", "text", "Assistant model", "Overrides the provider's default model.", { rule: "provider-default-model" }, "provider default"),
  deployment("aiModelsAnthropic", "DEZFIL_AI_MODELS_ANTHROPIC", "list", "Anthropic model offer", "Narrows and orders the catalogue; a set empty list offers only the default.", { rule: "effective-provider-catalogue" }, "unset"),
  deployment("aiModelsOpenai", "DEZFIL_AI_MODELS_OPENAI", "list", "OpenAI model offer", "Narrows and orders the catalogue; a set empty list offers only the default.", { rule: "effective-provider-catalogue" }, "unset"),
  deployment("assistantOffer", "DEZFIL_ASSISTANT_OFFER", "choice", "Assistant operation offer", "Choose the page's subset or its full admitted operation set.", "subset", "subset"),
  deployment("chromiumPath", "DEZFIL_CHROMIUM_PATH", "path", "Image renderer", "Headless browser binary used for server image export.", "/usr/bin/chromium", "/usr/bin/chromium"),
  stored("instanceName", "Instance name", "Name beside the wordmark and in browser titles.", null, { kind: "text", maxLength: 80, empty: "null" }),
  stored("signInMessage", "Sign-in message", "Optional message on the sign-in page.", "", { kind: "text", maxLength: 280, empty: "null" }),
  stored("lostPasswordContact", "Lost-password contact", "Contact line for password recovery; empty uses the built-in line.", "", { kind: "text", maxLength: 120, empty: "null" }),
  stored("landingPage", "Landing page", "Preferred entry destination after sign-in.", "home", choice("home", "projects", "maps", "workflows", "data", "sql")),
  ...INSTANCE_DEFAULT_SETTINGS,
  ...INSTANCE_SECURITY_SETTINGS,
  ...(["maps", "data", "workflows", "projects"] as const).flatMap(screen => [
    stored(`${screen}.view`, `${screen} view`, "The account's list layout.", "grid", choice("grid", "list"), "account"),
    stored(`${screen}.sort`, `${screen} sort`, "The account's list ordering.", screen === "maps" || screen === "workflows" ? "edited" : "updated",
      screen === "maps" || screen === "workflows" ? choice("edited", "created", "name") : screen === "data" ? choice("updated", "name", "rows", "size") : choice("updated", "name", "largest"), "account"),
  ]),
  stored("sourceGrouping", "SQL source grouping", "Group the account's SQL sources by person or project.", "person", choice("person", "project"), "account"),
  // The account's look: each pick's first choice is today's look, and the default.
  stored("look.color", "Color", "The interface's tint: accents, primary buttons, active marks, focus and the background's ink. Never a data color.",
    "kelp", choice("kelp", "harbor", "heather", "slate"), "account"),
  stored("look.contrast", "Contrast", "Borders, dividers and quieter text; more makes them stronger in both themes.",
    "standard", choice("standard", "more"), "account"),
  stored("look.font", "Typeface", "The face of everything read: Inter, or the computer's own. Identifiers and values keep the mono face.",
    "inter", choice("inter", "system"), "account"),
  stored("look.background", "Background", "The texture behind the workspace and in the header bar; plain is none.",
    "atlantic", choice("atlantic", "plain", "graticule", "hex"), "account"),
  stored("look.corners", "Corners", "Rounded edges of cards, fields, buttons and panels; soft is tighter.",
    "rounded", choice("rounded", "soft"), "account"),
  stored("look.rail", "Side menu", "How the side menu opens: on a resting pointer or focus, always open with labels, or icons only.",
    "hover", choice("hover", "open", "icons"), "account"),
  { ...deployment("port", "PORT", "text", "Listening port", "Port used by the server and its internal API calls.", { rule: "runtime-port-or-request-origin" }, "3000 in the container"), scope: "platform", changedBy: "platform" },
  { ...deployment("extensionDir", "DUCKDB_EXTENSION_DIR", "path", "Engine extensions", "Location of the baked offline extension bundle.", { rule: "engine-default-extension-directory" }, "/app/duckdb-extensions in the container"), scope: "platform", changedBy: "platform" },
];

/** Documented probe wiring is not an instance setting and is never exposed as one. */
export const TEST_WIRING = [
  { environment: "DEZFIL_TEST_PG_URL", documentedDefault: "unset", purpose: "Disposable PostGIS fixture URL for probes." },
  { environment: "DEZFIL_TEST_PUBLICATION_LOG", documentedDefault: "unset", purpose: "Publication observer output destination." },
  { environment: "DEZFIL_TEST_DERIVATION_LOG", documentedDefault: "unset", purpose: "Password derivation observer output destination." },
  { environment: "DEZFIL_TEST_EXTENSION_REPOSITORY", documentedDefault: "unset", purpose: "Loopback extension repository for the engine's installs under test." },
] as const;

const byKey = new Map(SETTING_CATALOGUE.map(definition => [definition.key, definition]));
export function settingDefinition(key: string): SettingDefinition {
  const definition = byKey.get(key);
  if (!definition) throw new Error(`Unknown setting: ${key}`);
  return definition;
}
