import { CARD_PICTURES, CATALOGUE_REFUSALS, CATALOGUE_STATES } from "@/lib/templates/card";
import { TEMPLATE_KINDS, TEMPLATE_TAGS, TEMPLATE_THEMES } from "@/lib/templates/format";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { LOCAL_READ, REMOTE_READ } from "./operation-mcp";
import { READ_ONLY, REACHES_OUTSIDE } from "./operation-metadata";

/**
 * Templates: finished maps and workflow examples with their data, shipped
 * in the image or listed by the template catalogue, read by every signed-in
 * account.
 */

const object = <T extends Record<string, unknown>>(properties: T) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const text = (description: string) => ({ type: "string", description });

const ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
const ID_PARAM = { name: "id", in: "path", required: true, schema: { type: "string", pattern: ID_PATTERN },
  description: "The template's id: lowercase letters, digits and hyphens, the same across its versions." };

const SIGNED_IN = "Every signed-in account, through cookie or bearer authentication; an anonymous request is refused. " +
  "Responses, including refusals, are private, no-store. ";

const CARD = {
  id: text("The template's id, the same across its versions."),
  kind: { type: "string", enum: [...TEMPLATE_KINDS], description: "A finished map, or a workflow example with its result map." },
  version: { type: "integer", minimum: 1, description: "The version an open or a copy begun now takes: the newest the catalogue lists, unless the installed one is as new." },
  title: text("The template's title."),
  question: text("The question it answers, in a line."),
  place: text("Where its data is."),
  tags: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: [...TEMPLATE_TAGS] }, description: "One to three tags from a closed list." },
  dataDate: { type: "string", pattern: "^\\d{4}(-\\d{2}(-\\d{2})?)?$", description: "The data's date: a year, a month or a day." },
  sources: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/TemplateSource" }, description: "Every source of its data, with its licence and the credit it asks for." },
  origin: { type: "string", enum: ["shipped", "catalogue"], description: "shipped: in this instance's image, working with no network; catalogue: listed by the template catalogue." },
  installed: { type: ["integer", "null"], minimum: 1, description: "The version installed on this server (shipped or downloaded), or null." },
  listed: { type: ["integer", "null"], minimum: 1, description: "The newest version the catalogue's last list names, or null." },
  present: { type: "boolean", description: "Whether version is installed; false means its first open or copy downloads it." },
  size: { type: "integer", minimum: 0, description: "The version's archive size in bytes, as transferred." },
  picture: { type: "string", enum: [...CARD_PICTURES],
    description: "kept: GET /api/templates/{id}/picture answers it; not_kept: the catalogue's picture could not be read, or the pictures kept for one list " +
      "reached their 64 MB first; too_large: the catalogue's picture was over its 2 MB bound and refused (template_picture_too_large)." },
};

export const TEMPLATES_SCHEMAS = {
  TemplateSource: object({
    name: text("Who published the data."),
    licence: text("The licence's identifier, as SPDX writes it."),
    credit: text("The credit text the source asks for, word for word."),
  }),
  TemplateCard: { ...object(CARD), description: "One template as its card draws it." },
  TemplateDetail: {
    ...object({
      ...CARD,
      howMade: object({
        question: text("The question in full."),
        datasets: { type: "array", items: object({ dataset: text("A dataset of the template."), source: text("The source it came from."), made: text("How it was made, in a line.") }) },
        styling: { type: "array", items: { type: "string" }, description: "The styling choices, a line each." },
      }),
    }),
    description: "One template: its card and how it is made.",
  },
  TemplateCatalogueState: {
    ...object({
      state: { type: "string", enum: [...CATALOGUE_STATES],
        description: "listed: the last read listed templates; empty: it listed none this server reads; not_read: no read since this process started or since " +
          "the address or the switch changed; off: an admin turned the catalogue off; unreachable: nothing answered; slow: no answer within the link import's " +
          "time bound; refused: see reason." },
      host: { type: ["string", "null"], description: "The catalogue's scheme and host, never its path or query; null for a folder or an address this server cannot read." },
      folder: { type: "boolean", description: "True when DEZFIL_TEMPLATES_CATALOGUE names a folder on this server; its path is never given." },
      readAt: { type: ["string", "null"], format: "date-time", description: "When the kept list was read; null before any read." },
      reason: { type: ["string", "null"], enum: [...CATALOGUE_REFUSALS, null],
        description: "Why it was refused: status (the catalogue answered with the status below), egress_blocked (the egress rules), service_address_unreadable " +
          "(a saved address the instance's key no longer opens), template_index_too_large (over 1 MB), template_index_invalid (not an index this server reads), " +
          "template_index_repeats_id (an id twice) or template_address_outside (an archive or picture address outside the catalogue's origin or folder). " +
          "Null unless the state is refused." },
      status: { type: ["integer", "null"], minimum: 100, maximum: 599, description: "The status the catalogue answered with; null unless the reason is status." },
    }),
    description: "Where the template catalogue stands for this list.",
  },
  TemplateList: object({
    templates: { type: "array", items: { $ref: "#/components/schemas/TemplateCard" },
      description: "Shipped templates first, in the image's order; then the catalogue's entries in its index's order, a shipped id winning over an entry naming it; " +
        "then downloaded templates the kept list does not name." },
    catalogue: { $ref: "#/components/schemas/TemplateCatalogueState" },
  }),
};

const LIST_RULES = "Shipped templates first, in the image's order; then the entries of the catalogue list this process last read, in its index's order, " +
  "a shipped id winning over an entry naming it; then the downloaded templates that list does not name, so the shipped and downloaded ones show whatever " +
  "the catalogue's state. A card takes the newest listed version unless the installed one is as new: an entry naming the installed version is drawn as " +
  "installed, and an absent one is present false with the size its first open downloads. ";

export const TEMPLATES_PATHS = {
  "/api/templates": { get: { ...op({
    summary: "List templates",
    description: SIGNED_IN + "Answers from what this server holds and sends nothing. " + LIST_RULES +
      "The catalogue's state says whether that list was read and, if not, why. Call POST /api/templates/refresh to read the catalogue again.",
    tag: "Templates", tool: "list_templates", toolInput: { closed: true },
    display: { verb: "Listed the templates" },
    effects: READ_ONLY, mcp: LOCAL_READ,
    responses: { "200": jsonOk("#/components/schemas/TemplateList"), "401": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/templates/refresh": { post: { ...op({
    summary: "Refresh the template catalogue",
    description: SIGNED_IN + "Cookie requests require the same trusted Origin; a bearer token calls directly. " +
      "Reads the catalogue's index at the address in effect (templatesCatalogueUrl, or the folder DEZFIL_TEMPLATES_CATALOGUE names), then each listed " +
      "template's pictures in the index's order, at most 2 MB each and 64 MB for the list, through the egress check, redirects included, within the link " +
      "import's time bound (DEZFIL_REMOTE_TIMEOUT_S), with no credential on any request. At most once in ten minutes: inside that window it sends nothing " +
      "and answers the list kept; while a read is under way it joins it. The list kept is replaced only once a new read is whole, and a read finishing " +
      "after the address or the switch changed is discarded. Refused, sending nothing: 409 templates_catalogue_off while an admin has turned the " +
      "catalogue off, and 400 service_address_unreadable for a saved address the instance's key no longer opens. A catalogue that fails answers the " +
      "list with its state. Answers the list, as GET /api/templates does.",
    tag: "Templates", tool: "refresh_templates", toolInput: { closed: true },
    display: { verb: "Reached outside this server to refresh the template catalogue" },
    effects: REACHES_OUTSIDE, mcp: REMOTE_READ,
    responses: { "200": jsonOk("#/components/schemas/TemplateList"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE,
      "409": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/templates/{id}": { get: { ...op({
    summary: "Read a template",
    description: SIGNED_IN + "Answers one template's card, as the list draws it, and how it is made; sends nothing. " +
      "An id no shipped, downloaded or listed template has answers 404 template_not_listed.",
    tag: "Templates", tool: "get_template", toolInput: { closed: true },
    display: { verb: "Read the template {subject}", subject: { resource: "templates", argument: "id", name: ["title"] } },
    effects: READ_ONLY, mcp: LOCAL_READ,
    parameters: [ID_PARAM],
    responses: { "200": jsonOk("#/components/schemas/TemplateDetail"), "401": ERROR_RESPONSE, "404": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/templates/{id}/picture": { get: { ...op({
    summary: "Read a template's picture",
    description: "Every signed-in account, through cookie or bearer authentication; an anonymous request is refused. The picture is private and kept " +
      "by the browser for five minutes; refusals are private, no-store. The card's map picture as PNG, in the theme named (light when none is): from disk for a " +
      "shipped or downloaded version, else as the catalogue's last list kept it. 404 not_found when its card's picture is not kept; an unknown id answers " +
      "404 template_not_listed.",
    tag: "Templates",
    // The card's image, as a map's snapshot is: outside the agent tool set.
    tool: false,
    effects: READ_ONLY,
    parameters: [ID_PARAM, { name: "theme", in: "query", required: false, schema: { type: "string", enum: [...TEMPLATE_THEMES] },
      description: "The theme's picture: light (the default) or dark." }],
    responses: {
      "200": { description: "The picture.", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
      "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "404": ERROR_RESPONSE,
    },
  }), security: AUTH_SECURITY } },
};
