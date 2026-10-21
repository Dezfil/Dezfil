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
/** An address set by its variable or stored by an admin beside it (a
 * service's, or the imagery's tile template with its placeholders, which
 * takes no user information since no imagery is drawn from one carrying
 * it): a set variable locks
 * it. Write-only, like the rest of the address kind: what any read gives
 * back is its scheme and host. */
function serviceAddress(key: string, environment: string, label: string, purpose: string,
  defaultValue: SettingDefault, documentedDefault: string, template?: { readonly placeholders: readonly string[] }): SettingDefinition {
  return { ...deployment(key, environment, "address", label, purpose, defaultValue, documentedDefault),
    changedBy: "admin", timing: "live", editable: true,
    write: { kind: "address", maxLength: 2048, ...(template ? { placeholders: template.placeholders, userInformation: "refused" as const } : {}) } };
}
/** Where the template catalogue is read: the release catalogue unless an
 * admin stores another address beside its variable. The variable alone may
 * name a folder on the server instead, read as files under the same checks:
 * a token or the assistant could otherwise point the server at any folder
 * it can read. */
const TEMPLATES_CATALOGUE = "https://github.com/Dezfil/templates/releases/latest/download/index.json";
function catalogueAddress(): SettingDefinition {
  const definition = serviceAddress("templatesCatalogueUrl", "DEZFIL_TEMPLATES_CATALOGUE", "Catalogue address",
    "Where the template catalogue's index is read.", TEMPLATES_CATALOGUE, TEMPLATES_CATALOGUE);
  return { ...definition, write: { kind: "address", maxLength: 2048, folder: "variable" } };
}
/** Whether the server reads the template catalogue at all: a switch an
 * admin turns, on by default, read by every signed-in account and set by
 * no variable. */
function catalogueSwitch(): SettingDefinition {
  return { key: "templates.catalogue", label: "Use the catalogue",
    purpose: "Whether the server reads the template catalogue: its list, its pictures and its downloads. Off, it reaches the catalogue " +
      "for nothing; shipped and downloaded templates still open and copy.",
    defaultValue: true, documentedDefault: "on", scope: "instance", readBy: "signed-in", changedBy: "admin",
    kind: "boolean", timing: "live", secret: false, editable: true, write: { kind: "switch" } };
}
/** Which settings are the Templates table's, for a reader of the catalogue
 * alone: the stored rows of the template catalogue that no variable sets. */
export function isTemplatesSetting(definition: { readonly key: string; readonly scope: string; readonly environment?: string }): boolean {
  return definition.scope === "instance" && !definition.environment && definition.key.split(".")[0] === "templates";
}
/** Text set by its variable or stored by an admin beside it: a set variable locks it. */
function textBeside(key: string, environment: string, label: string, purpose: string, maxLength: number): SettingDefinition {
  return { ...deployment(key, environment, "text", label, purpose, null, "unset"),
    changedBy: "admin", timing: "live", editable: true, write: { kind: "text", maxLength, empty: "null" } };
}
/** Which basemaps the instance offers where one is chosen, and whether a
 * map may take a style address of its own: switches an admin turns, on by
 * default, read by every signed-in account and set by no variable, so no
 * deployment pins one. */
function basemapSwitch(key: string, label: string, purpose: string): SettingDefinition {
  return { key, label, purpose, defaultValue: true, documentedDefault: "on", scope: "instance", readBy: "signed-in", changedBy: "admin",
    kind: "boolean", timing: "live", secret: false, editable: true, write: { kind: "switch" } };
}
/** Which settings are the Libraries tab's switches, for a reader of the
 * catalogue alone: the basemaps offered and whether a single map may take a
 * style address of its own. */
export function isLibrarySwitch(definition: { readonly key: string; readonly scope: string; readonly environment?: string }): boolean {
  return definition.scope === "instance" && !definition.environment && definition.key.split(".")[0] === "basemaps";
}
const OFFERED = "where a basemap is chosen: the builder's picker, a published page's switcher and the Maps tab. " +
  "Off, choosing it anew is refused; a map already on it keeps it.";
export const SETTING_CATALOGUE: readonly SettingDefinition[] = [
  ...NUMERIC_SETTINGS,
  deployment("assistantAutoCheck", "DEZFIL_ASSISTANT_AUTO_CHECK", "boolean", "Automatic map check", "Check the rendered map after an assistant turn changes it.", true, "on"),
  deployment("dataDir", "DEZFIL_DATA_DIR", "path", "Data directory", "The single durable directory for tables, tiles and metadata.", { rule: "working-directory/data" }, "./data; /data in the container"),
  deployment("secretKey", "DEZFIL_SECRET_KEY", "secret", "Encryption key", "The key that encrypts saved connection passwords and service addresses.", { rule: "key-file-or-generate" }, "generated"),
  deployment("trustedProxies", "DEZFIL_TRUSTED_PROXIES", "list", "Trusted proxies", "The proxies whose forwarded visitor address, host, scheme and port Dezfil accepts.", [], "unset"),
  deployment("sessionCookie", "DEZFIL_SESSION_COOKIE", "text", "Session cookie name", "Browser session cookie name, derived from the listening port unless overridden.", { rule: "listening-port" }, "port-based"),
  deployment("egressAllowlist", "DEZFIL_EGRESS_ALLOWLIST", "list", "Allowed destinations", "Hosts on a private network that the server may reach.", [], "unset"),
  deployment("objectStoreCredentials", "DEZFIL_OBJECT_STORE_CREDENTIALS", "boolean", "Object-store credentials", "Read cloud storage links with the server's own credentials.", false, "off"),
  serviceAddress("s3Endpoint", "DEZFIL_S3_ENDPOINT", "S3 endpoint", "The S3-compatible store that s3:// links are read from without the server's credentials.", { rule: "aws-bucket-endpoint" }, "AWS"),
  serviceAddress("overpassUrl", "DEZFIL_OVERPASS_URL", "Overpass endpoint", "Endpoint for OpenStreetMap imports.", "https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter"),
  deployment("overtureS3Endpoint", "DEZFIL_OVERTURE_S3_ENDPOINT", "address", "Overture endpoint", "S3-compatible override for the public Overture bucket.", null, "unset, the public bucket"),
  deployment("tippecanoe", "DEZFIL_TIPPECANOE", "path", "Tile builder", "The program that builds vector tiles.", "tippecanoe", "tippecanoe"),
  deployment("basemapUrl", "DEZFIL_BASEMAP_URL", "address", "Basemap address", "A basemap style that Auto draws in both themes, in place of the built-in ones.", { rule: "built-in-basemap-for-theme" }, "built-in styles"),
  deployment("basemapAttribution", "DEZFIL_BASEMAP_ATTRIBUTION", "text", "Basemap credit", "The credit maps show for the style DEZFIL_BASEMAP_URL names.", null, "unset"),
  serviceAddress("satelliteUrl", "DEZFIL_SATELLITE_URL", "Satellite template", "Raster tile template enabling satellite imagery.", null, "unset", { placeholders: ["{z}", "{x}", "{y}"] }),
  textBeside("satelliteAttribution", "DEZFIL_SATELLITE_ATTRIBUTION", "Satellite credit", "Credit line required by the imagery provider.", 160),
  serviceAddress("geocoderUrl", "DEZFIL_GEOCODER_URL", "Address finder", "Nominatim-compatible endpoint for search and batch geocoding.", null, "unset"),
  serviceAddress("isochroneUrl", "DEZFIL_ISOCHRONE_URL", "Travel-time endpoint", "Valhalla-compatible endpoint for travel-time areas.", null, "unset"),
  catalogueAddress(),
  deployment("anthropicApiKey", "ANTHROPIC_API_KEY", "secret", "Anthropic credential", "Enables the assistant with this provider.", null, "unset"),
  deployment("openaiApiKey", "OPENAI_API_KEY", "secret", "OpenAI credential", "Enables the assistant with this provider.", null, "unset"),
  deployment("aiProvider", "DEZFIL_AI_PROVIDER", "choice", "Assistant provider", "Selects the provider when more than one credential is present.", { rule: "first-provider-with-key" }, "first key set"),
  deployment("aiModel", "DEZFIL_AI_MODEL", "text", "Assistant model", "Overrides the provider's default model.", { rule: "provider-default-model" }, "provider default"),
  deployment("aiModelsAnthropic", "DEZFIL_AI_MODELS_ANTHROPIC", "list", "Anthropic model offer", "Narrows and orders the catalogue; a set empty list offers only the default.", { rule: "effective-provider-catalogue" }, "unset"),
  deployment("aiModelsOpenai", "DEZFIL_AI_MODELS_OPENAI", "list", "OpenAI model offer", "Narrows and orders the catalogue; a set empty list offers only the default.", { rule: "effective-provider-catalogue" }, "unset"),
  deployment("assistantOffer", "DEZFIL_ASSISTANT_OFFER", "choice", "Assistant operation offer", "With subset, the assistant starts with the page's own tools and looks up the rest; with full, it starts with every tool the page allows.", "subset", "subset"),
  deployment("chromiumPath", "DEZFIL_CHROMIUM_PATH", "path", "Image renderer", "The headless browser that draws image exports and map pictures.", "/usr/bin/chromium", "/usr/bin/chromium"),
  stored("instanceName", "Instance name", "Name beside the wordmark and in browser titles.", null, { kind: "text", maxLength: 80, empty: "null" }),
  stored("signInMessage", "Sign-in message", "Optional message on the sign-in page.", "", { kind: "text", maxLength: 280, empty: "null" }),
  stored("lostPasswordContact", "Lost-password contact", "Contact line for password recovery; empty uses the built-in line.", "", { kind: "text", maxLength: 120, empty: "null" }),
  stored("landingPage", "Landing page", "Preferred entry destination after sign-in.", "home", choice("home", "projects", "maps", "workflows", "data", "sql")),
  ...INSTANCE_DEFAULT_SETTINGS,
  ...INSTANCE_SECURITY_SETTINGS,
  basemapSwitch("basemaps.dark", "Dark", `Whether Dark is offered ${OFFERED} Auto keeps following the theme with it either way.`),
  basemapSwitch("basemaps.light", "Light", `Whether Light is offered ${OFFERED} Auto keeps following the theme with it either way.`),
  basemapSwitch("basemaps.streets", "Streets", `Whether Streets is offered ${OFFERED}`),
  basemapSwitch("basemaps.satellite", "Satellite", `Whether Satellite is offered, while imagery is set up, ${OFFERED}`),
  basemapSwitch("basemaps.singleMapStyles", "Style addresses on single maps",
    "Whether a map may take a style address the library does not offer. Off, such an address is refused on any map, for everyone, " +
    "admins included; a map that holds one keeps it."),
  catalogueSwitch(),
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
  stored("look.panels", "Panels", "How cards and panels are drawn: frosted glass, liquid glass with a light on its rim, or opaque paper with no blur.",
    "glass", choice("glass", "liquid", "paper"), "account"),
  stored("look.transparency", "Transparency", "How much of the map shows through Liquid's cards and panels: clear, medium or firm. Only while Panels is Liquid.",
    "clear", choice("clear", "medium", "firm"), "account"),
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
