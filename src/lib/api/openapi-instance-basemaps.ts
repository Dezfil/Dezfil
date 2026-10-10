import { LIBRARY_LIMITS } from "@/lib/basemap";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op, pathParam } from "./openapi-helpers";
import { LOCAL_DELETE, LOCAL_REPLACE, REMOTE_ADD } from "./operation-mcp";
import { resource, writes } from "./operation-metadata";

/**
 * The instance's basemap library: styles an admin adds by their address,
 * offered to everyone choosing a basemap.
 */

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

const offer = {
  id: { type: "string", description: "The style's identity in the library." },
  name: { type: "string", minLength: 1, maxLength: LIBRARY_LIMITS.name, description: "The name a person choosing a basemap sees." },
  url: { type: "string", description: "The style's address, public to whoever draws a map on it, as a map's own style address is." },
  attribution: { $ref: "#/components/schemas/BasemapAttribution" },
};

/** A style as a person choosing a basemap is offered it. */
export const LIBRARY_STYLE_OFFER_SCHEMA = {
  ...object(offer),
  description: "A style an admin added to the library by its address, offered where a basemap is chosen. A map that takes it keeps its own copy of the name, the address and the credit.",
};

/** The whole library as the configuration read gives it, hidden styles included. */
export const LIBRARY_STYLES_SCHEMA = {
  type: "array", maxItems: LIBRARY_LIMITS.styles, items: { $ref: "#/components/schemas/LibraryStyle" },
  description: "The basemap library, oldest first, hidden styles included.",
};

const ADMIN = "Requires a current admin through cookie or bearer authentication, rechecked inside the write on every call. " +
  "Cookie requests require the same trusted Origin; an admin bearer token calls directly. Responses, including refusals, are private, no-store. ";
const POLICY = "The embedded assistant asks for confirmation before calling on pages admitting writes; SQL and workflow assistants refuse this operation. " +
  "MCP advertises that policy and adds no confirmation step.";
const SUBJECT = { path: "/api/instance/settings", argument: "id", name: "name", collection: "basemapStyles", identity: "id" };

export const INSTANCE_BASEMAPS_SCHEMAS = {
  LibraryStyle: {
    ...object({
      ...offer,
      offered: { type: "boolean", description: "Whether the style is offered where a basemap is chosen. Hidden, maps already on a copy of it keep it." },
      addedAt: { type: "string", format: "date-time" },
    }),
    description: "A style in the basemap library.",
  },
  LibraryStyleAdd: {
    ...object({
      name: { type: "string", pattern: `^\\s*\\S[\\s\\S]{0,${LIBRARY_LIMITS.name - 1}}\\s*$`, description: `1 to ${LIBRARY_LIMITS.name} characters once trimmed.` },
      url: { type: "string", pattern: "^\\s*[Hh][Tt][Tt][Pp][Ss]?://[^/\\\\?#\\s]", description: `An http or https MapLibre style address with a host, at most ${LIBRARY_LIMITS.address.toLocaleString("en-US")} characters once trimmed, kept as given.` },
    }),
  },
  LibraryStyleOffered: object({ offered: { type: "boolean", description: "True offers the style where a basemap is chosen; false hides it." } }),
  LibraryStyleRemoved: object({ removed: { const: true } }),
};

export const INSTANCE_BASEMAPS_PATHS = {
  "/api/instance/basemaps": { post: { ...op({
    summary: "Add a style to the basemap library",
    description: ADMIN +
      "Adds a MapLibre style by its address, for everyone choosing a basemap: the builder's picker lists it after the built-in styles, and a map " +
      "that takes it keeps its own copy of the name, the address and the credit. The server reads the address once, now: first the egress " +
      "policy's own check, so an address in loopback, private, link-local, metadata or other blocked space, or a name all of whose addresses resolve " +
      "there, is refused with that check's sentence before anything is sent, unless DEZFIL_EGRESS_ALLOWLIST names it; then one request through the " +
      "egress-governed client, redirects included, within 8 seconds and 2 MB. A valid style is kept with its sources' credit, else its host. " +
      "Refused with 400 invalid_request, nothing kept: a name outside 1 to 60 characters, an address that is not http or https with a host or is longer " +
      `than ${LIBRARY_LIMITS.address.toLocaleString("en-US")} characters, an address the library already holds, a ${LIBRARY_LIMITS.styles + 1}st style, ` +
      "an answer that is not a MapLibre style, and a style that cannot be read now: there is no force, because an offered style must draw in the " +
      "server's images too. No refusal repeats the address. Nothing reads the address again: no schedule and no recheck. Its address is public " +
      "to whoever draws a map on it, published readers included. " + POLICY,
    tag: "System", tool: "add_basemap_style", toolInput: { closed: true },
    display: { verb: "Added the basemap style {subject}", subject: { resource: "basemaps", result: "id", name: ["name"] } },
    effects: writes(resource("basemaps", "", "id")), mcp: REMOTE_ADD, confirm: true,
    confirmation: { target: "Add {target} to the basemap library?",
      consequence: "This server reads the style's address once to check it and take its credit, then offers it to everyone choosing a basemap. Its address is public to whoever draws a map on it.",
      subject: { path: null, argument: "name", name: "" } },
    requestBody: { required: true, "x-byte-limit": 65_536, content: { "application/json": { schema: { $ref: "#/components/schemas/LibraryStyleAdd" },
      example: { name: "Harbour chart", url: "https://tiles.example.org/styles/harbour/style.json" } } } },
    responses: { "201": jsonOk("#/components/schemas/LibraryStyle", "Added."), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE,
      "413": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/instance/basemaps/{id}": {
    patch: { ...op({
      summary: "Offer or hide a library style",
      description: ADMIN +
        "Sets whether an added style is offered where a basemap is chosen. Hidden, it leaves the builder's picker and the runtime configuration; " +
        "maps that took it keep their copy and draw it. Answers the style as it is now; an unknown id answers 404 not_found. " + POLICY,
      tag: "System", tool: "set_basemap_style_offered", toolInput: { closed: true },
      display: { verb: "Set whether the basemap style {subject} is offered", subject: { resource: "basemaps", argument: "id", name: ["name"] } },
      effects: writes(resource("basemaps", "id")), mcp: LOCAL_REPLACE, confirm: true,
      confirmation: { target: "Change whether {target} is offered?",
        consequence: "Hidden, it leaves every basemap picker; maps that already took it keep it.", subject: SUBJECT },
      parameters: [pathParam("id", "The style's identity in the library.")],
      requestBody: { required: true, "x-byte-limit": 65_536, content: { "application/json": { schema: { $ref: "#/components/schemas/LibraryStyleOffered" },
        example: { offered: false } } } },
      responses: { "200": jsonOk("#/components/schemas/LibraryStyle"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE,
        "404": ERROR_RESPONSE, "413": ERROR_RESPONSE, "503": ERROR_RESPONSE },
    }), security: AUTH_SECURITY },
    delete: { ...op({
      summary: "Remove a library style",
      description: ADMIN +
        "Removes an added style from the library. Maps that took it keep their copy of its name, address and credit and keep drawing it; " +
        "nothing else changes. An unknown id answers 404 not_found. " + POLICY,
      tag: "System", tool: "remove_basemap_style", toolInput: { closed: true },
      display: { verb: "Removed the basemap style {subject}", subject: { resource: "basemaps", argument: "id" } },
      effects: writes(resource("basemaps", "id")), mcp: LOCAL_DELETE, confirm: true,
      confirmation: { target: "Remove {target} from the basemap library?", consequence: "Maps that already took it keep their copy.", subject: SUBJECT },
      parameters: [pathParam("id", "The style's identity in the library.")],
      responses: { "200": jsonOk("#/components/schemas/LibraryStyleRemoved"), "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE,
        "503": ERROR_RESPONSE },
    }), security: AUTH_SECURITY },
  },
};
