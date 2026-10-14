import { CARD_PICTURES, CATALOGUE_REFUSALS, CATALOGUE_STATES } from "@/lib/templates/card";
import { TEMPLATE_KINDS, TEMPLATE_STEPS_MAX, TEMPLATE_TAGS, TEMPLATE_THEMES } from "@/lib/templates/format";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { ownedCreationOp } from "./openapi-owned-creation";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, REMOTE_ADD, REMOTE_READ } from "./operation-mcp";
import { READ_ONLY, REACHES_OUTSIDE, resource, writes } from "./operation-metadata";

/**
 * Templates: finished maps and workflow examples with their data, shipped
 * in the image or listed by the template catalogue, read by every signed-in
 * account.
 */

const object = <T extends Record<string, unknown>>(properties: T, optional: Record<string, unknown> = {}) => ({
  type: "object", properties: { ...properties, ...optional }, required: Object.keys(properties), additionalProperties: false,
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
  steps: {
    type: ["array", "null"], minItems: 1, maxItems: TEMPLATE_STEPS_MAX,
    items: object({
      id: text("The step's id in the template's workflow."),
      operation: text("The operation it runs, by its id in the operation catalogue."),
      output: text("The name of the dataset it makes."),
      reads: { type: "array", items: { type: "string" },
        description: "The names it reads: datasets of the template and earlier steps' outputs, never anything outside the template." },
    }),
    description: "A workflow example's steps in their order, as its workflow holds them, so its graph can be drawn before it is downloaded; null for a map template.",
  },
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
      contents: { anyOf: [{ $ref: "#/components/schemas/TemplateContents" }, { type: "null" }],
        description: "What the version holds, once it is installed on this server (shipped, or downloaded and whole by its record); null while it is not, " +
          "or when its files do not read. POST /api/templates/{id}/fetch installs a listed version." },
    }),
    description: "One template: its card, how it is made, and what its version holds once installed.",
  },
  TemplateDataset: {
    ...object({
      id: text("Its id as a template's dataset or bundled result, never a stored dataset's: no dataset operation answers it."),
      name: text("The name the template's SQL and steps read it by."),
      rowCount: { type: "integer", minimum: 0, description: "Its rows, as measured when the version was installed." },
      geometryColumn: { type: ["string", "null"], description: "Its geometry column, or null for a table without geometry." },
      geometryType: { type: ["string", "null"], description: "Its geometry type as measured, or null." },
    }),
    description: "A dataset of an installed template version, or a step's bundled result.",
  },
  TemplateContents: {
    ...object({
      mapId: text("The template map's id. GET /api/maps/{id} reads the map with its layers' SQL and styles, and the layer render and widget-value " +
        "operations answer its layers, as for a map one may only view; nothing writes it."),
      revision: text("The version's revision, from its archive's checksum; the same for as long as the version is installed."),
      createdAt: { type: "string", format: "date-time", description: "When the template's map was made, as it was published." },
      updatedAt: { type: "string", format: "date-time", description: "When the template's map last changed before it was published." },
      datasets: { type: "array", items: { $ref: "#/components/schemas/TemplateDataset" }, description: "The template's own datasets." },
      workflow: {
        anyOf: [object({
          name: text("The workflow's name."),
          steps: { type: "array", minItems: 1, maxItems: TEMPLATE_STEPS_MAX, items: object({
            id: text("The step's id in the template's workflow."),
            operation: text("The operation it runs, by its id in the operation catalogue."),
            parameters: { type: "object", description: "Its parameters as the workflow holds them, its output's name among them, as a workflow's step is defined." },
            output: { $ref: "#/components/schemas/TemplateDataset" },
            reads: { type: "array", items: { type: "string" }, description: "The names it reads: the template's datasets and earlier steps' outputs." },
          }), description: "The steps in their order, each with the bundled result it came with as its output; a template's workflow never runs." },
          layout: object({
            steps: { type: "object", additionalProperties: { $ref: "#/components/schemas/LayoutPosition" }, description: "A position per step, keyed by step id." },
            sources: { type: "object", additionalProperties: { $ref: "#/components/schemas/LayoutPosition" }, description: "A position per dataset read, keyed by its name." },
            notes: { type: "array", items: { $ref: "#/components/schemas/LayoutNote" }, description: "The canvas's notes, in their order." },
            updatedAt: { type: ["string", "null"], format: "date-time",
              description: "When the arrangement was last written before the version was published; null for one with nothing placed, which the canvas arranges itself." },
          }),
        }), { type: "null" }],
        description: "A workflow example's workflow: its steps with their parameters and its saved canvas arrangement; null for a map template.",
      },
    }),
    description: "What an installed template version holds, read from this server: its map's id, its datasets and a workflow example's workflow.",
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
    }, {
      message: text("Only for template_index_invalid, a plain-text reason naming the first offending field and its entry’s zero-based position and id when available, without other index values."),
    }),
    description: "Where the template catalogue stands for this list.",
  },
  TemplateFetched: {
    ...object({
      id: text("The template's id."),
      version: { type: "integer", minimum: 1, description: "The version fetched: the one the request named, else the one its card took." },
      size: { type: "integer", minimum: 0, description: "Its archive's size in bytes, as transferred." },
      downloaded: { type: "boolean",
        description: "True when this call downloaded and installed it, or joined the download that did; false when it was installed already and nothing was sent." },
    }),
    description: "A template's version, installed on this server.",
  },
  TemplateCopy: {
    ...object({
      project: { $ref: "#/components/schemas/Project" },
      members: { $ref: "#/components/schemas/ProjectMembers" },
    }),
    description: "The project a copy made, with its members: the copied map, the copied workflow of a workflow example, and the copied datasets.",
  },
  TemplateDownloads: {
    ...object({
      versions: { type: "integer", minimum: 0, description: "How many downloaded versions." },
      bytes: { type: "integer", minimum: 0, description: "The bytes their folders take in the data folder." },
    }),
    description: "What the downloaded templates hold on this server, which DELETE /api/templates/downloads frees. Shipped templates and copies are not among them.",
  },
  TemplateList: object({
    templates: { type: "array", items: { $ref: "#/components/schemas/TemplateCard" },
      description: "Shipped templates first, in the image's order; then the catalogue's entries in its index's order, a shipped id winning over an entry naming it; " +
        "then downloaded templates the kept list does not name." },
    catalogue: { $ref: "#/components/schemas/TemplateCatalogueState" },
    downloads: { $ref: "#/components/schemas/TemplateDownloads" },
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
      "import's time bound (DEZFIL_REMOTE_TIMEOUT_S), with no credential on any request. At most once in ten minutes after a successful read, or thirty seconds after a refused or failed read: inside that window it sends nothing " +
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
  "/api/templates/downloads": { delete: { ...op({
    summary: "Remove the downloaded templates",
    description: "Requires a current admin through cookie or bearer authentication, rechecked on every call. " +
      "Cookie requests require the same trusted Origin; an admin bearer token calls directly. Responses, including refusals, are private, no-store. " +
      "Removes every template version downloaded to this server when the call began, with the engine's copies of its data that no installed " +
      "version needs any more; shipped templates, and every copy anyone made, are untouched. Each version is retired as a dataset's file is: no " +
      "open, copy or render begun after the call finds it, readers already under way finish first, and only then are its files removed; a " +
      "download that lands meanwhile stays. A removed template downloads again at its next open or copy while the catalogue lists it. Sends " +
      "nothing outside this server. Removing when nothing is downloaded answers the same, with nothing removed. Answers how many versions went " +
      "and the bytes their folders took. The embedded assistant asks for confirmation before calling; SQL and workflow assistants refuse this " +
      "operation. MCP advertises that policy and adds no confirmation step.",
    tag: "Templates", tool: "remove_template_downloads", toolInput: { closed: true },
    confirm: true,
    confirmation: {
      target: "Remove every downloaded template from this server?",
      consequence: "The downloads take {size}. Shipped templates and the copies people made stay as they are, and a removed template downloads " +
        "again at its next open.",
      subject: {
        path: "/api/templates", argument: "", name: "",
        facts: { size: { path: "downloads.bytes", bytes: true, fallback: "the space Storage shows for templates" } },
      },
    },
    display: { verb: "Removed the downloaded templates" },
    effects: writes(resource("templates")), mcp: LOCAL_DELETE,
    responses: { "200": jsonOk("#/components/schemas/TemplateDownloads"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE,
      "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/templates/{id}": { get: { ...op({
    summary: "Read a template",
    description: SIGNED_IN + "Answers one template's card, as the list draws it, how it is made and, once its version is installed on this server, " +
      "what that version holds: its map's id (read through GET /api/maps/{id}), its datasets as measured and a workflow example's steps with their " +
      "parameters and its saved canvas arrangement. Sends nothing. Reads the version the query names, else the one its card takes now. " +
      "An id no shipped, downloaded or listed template has, or a version that is neither installed nor the one the catalogue's last list names, " +
      "answers 404 template_not_listed; a version that is not a whole number from 1, 400 invalid_request.",
    tag: "Templates", tool: "get_template", toolInput: { closed: true },
    display: { verb: "Read the template {subject}", subject: { resource: "templates", argument: "id", name: ["title"] } },
    effects: READ_ONLY, mcp: LOCAL_READ,
    parameters: [ID_PARAM, { name: "version", in: "query", required: false, schema: { type: "integer", minimum: 1 },
      description: "The version to read: one installed on this server, or the one the catalogue's last list names. Without it, the version " +
        "its card takes now: the newest listed, unless the installed one is as new." }],
    responses: { "200": jsonOk("#/components/schemas/TemplateDetail"), "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "404": ERROR_RESPONSE,
      "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY } },
  "/api/templates/{id}/fetch": { post: { ...op({
    summary: "Fetch a template",
    description: SIGNED_IN + "Cookie requests require the same trusted Origin; a bearer token calls directly. " +
      "Downloads one version of a template so it opens and copies with no further request: the version the body names, else the one its card takes " +
      "now. An installed version (shipped, or downloaded before) answers at once and sends nothing; a shipped template has its shipped version alone. " +
      "Otherwise the version must be the one the catalogue list this process last read names (POST /api/templates/refresh reads it again). Its " +
      "archive is read from its address through the egress check, redirects included, within the link import's time bound (DEZFIL_REMOTE_TIMEOUT_S), " +
      "with no credential on any request, or from the catalogue's folder; its size and SHA-256 are checked against the index; then it is unpacked " +
      "and admitted as a client's documents are, every dataset read through the upload's reader, every layer and step bound to the template's own " +
      "data and nothing else; and only then is it installed. Two calls for one version download it once, and downloads run one at a time on this " +
      "instance. A version installed before stays as it is. Refused, coded, leaving nothing installed: 404 template_not_listed for a version neither " +
      "installed nor listed; 409 templates_catalogue_off while an admin has turned the catalogue off; 400 service_address_unreadable for a saved " +
      "address the instance's key no longer opens; 413 template_archive_too_large (over the declared size or 150 MB), template_unpacked_too_large or " +
      "template_picture_too_large; 422 template_checksum_mismatch and the template reader's other codes, template_reference_outside among them for a " +
      "layer or step naming a dataset that is not the template's; 403 egress_blocked; 502 remote_fetch_failed; 504 remote_timeout. " +
      "Answers the version installed.",
    tag: "Templates", tool: "fetch_template", toolInput: { closed: true },
    confirm: true,
    confirmation: {
      target: "Download version {version} of {target}?",
      consequence: "Its archive, {size}, comes from the template catalogue and is checked whole before it is installed on this server. " +
        "Nothing is downloaded if that version is installed already.",
      subject: {
        path: "/api/templates/{id}", argument: "id", name: "title",
        binds: { argument: "version", path: "version" },
        facts: { size: { path: "size", bytes: true, fallback: "of the size the catalogue lists" } },
      },
    },
    display: { verb: "Fetched the template {subject}", subject: { resource: "templates", argument: "id" } },
    effects: writes(resource("templates", "id")), mcp: REMOTE_ADD,
    parameters: [ID_PARAM],
    requestBody: {
      "x-byte-limit": 65_536,
      required: false,
      content: { "application/json": { schema: {
        type: "object",
        properties: { version: { type: "integer", minimum: 1, description: "The version to fetch; without it, the one the template's card takes now." } },
        additionalProperties: false,
      } } },
    },
    responses: {
      "200": jsonOk("#/components/schemas/TemplateFetched"),
      "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "409": ERROR_RESPONSE,
      "413": ERROR_RESPONSE, "422": ERROR_RESPONSE, "502": ERROR_RESPONSE, "503": ERROR_RESPONSE, "504": ERROR_RESPONSE,
    },
  }), security: AUTH_SECURITY } },
  "/api/templates/{id}/copy": { post: { ...ownedCreationOp({
    summary: "Copy a template",
    description: SIGNED_IN + "Cookie requests require the same trusted Origin; a bearer token calls directly. " +
      "Makes a copy of one installed version of a template into a new project of the caller's, private under the ownership rules, all of it or " +
      "nothing: the version the body names, else the installed one. The copy is local and sends nothing: an installed version is copied whether the " +
      "catalogue still lists it or not, and with the catalogue off; a listed version that is not installed is refused with 409 template_not_installed, " +
      "so fetch it first (POST /api/templates/{id}/fetch). The project is named as the body says (trimmed, 1 to 120 characters), else after the " +
      "template's title, and its note carries a line naming the template, its version and the day. Filed in it, under fresh identities: the " +
      "template's map with every layer, widget, the legend order, camera, basemap and timeline, each widget, the legend order and the timeline bound " +
      "to the copied layers, its SQL home the caller's; a workflow example's workflow, each step the caller's own, reading the datasets and the " +
      "earlier outputs as landed and declaring its output as landed, each bundled result recorded as the caller's output of its step by no job and " +
      "no run (the workflow read gives such a step no lastSuccessAt and its templateResult until the step's first run replaces it), its canvas " +
      "layout with every position under the copy's step or the dataset as landed and every note; and every dataset and bundled result of the " +
      "template, the caller's, under its name in the template or the next free name by the suffix rule (`_2`, `_3`), reserved against the " +
      "caller's datasets and every output name their workflows declare, each layer's SQL naming the dataset as landed. A copied dataset's source " +
      "reads `template`, with the template's id and version in its sourceParams, and it is never refreshed. The map's card images are the template's pictures, saved after the copy with evidence naming the " +
      "copied datasets; when they cannot be saved the copy stands and its card shows the placeholder until the map's first capture. A second copy " +
      "makes a second project of the same name with its datasets suffixed, the first unchanged; copies made at once each land whole under distinct " +
      "names. Refused, coded, with nothing created: 404 template_not_listed for a version neither installed nor listed; 409 " +
      "template_not_installed; 409 templates_catalogue_off for a version not installed while an admin has turned the catalogue off; 400 " +
      "service_address_unreadable for a saved address the instance's key no longer opens; 422 template_reference_unbound for a layer naming a " +
      "dataset the copy does not make, or a step reading one; 422 template_record_mismatch and the template reader's other codes for an installed version that changed on " +
      "disk; 400 invalid_request for a body that is not an optional name and version; 413 request_body_too_large. Answers the project with its " +
      "members.",
    tag: "Templates", tool: "copy_template", toolInput: { closed: true },
    confirm: true,
    confirmation: {
      target: "Copy version {version} of {target} into a new project?",
      consequence: "Its map, its workflow if it has one, and its datasets (an archive of {size}) become yours in a new project; " +
        "the template stays as it is.",
      subject: {
        path: "/api/templates/{id}", argument: "id", name: "title",
        binds: { argument: "version", path: "installed", absent: "template_not_installed" },
        facts: { size: { path: "size", bytes: true, of: "version", fallback: "the size the template lists" } },
      },
    },
    display: { verb: "Copied the template into the project {subject}",
      subject: { resource: "projects", result: "project.id", name: ["project.name"] } },
    effects: writes(
      resource("projects", "", "project.id"),
      resource("maps", "", "members.maps.*.id"),
      resource("layers"),
      resource("recipes", "", "members.recipes.*.id"),
      resource("tables", "", "members.tables.*.id"),
    ),
    mcp: LOCAL_ADD,
    parameters: [ID_PARAM],
    requestBody: {
      "x-byte-limit": 65_536,
      required: false,
      content: { "application/json": { schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The new project's name, trimmed, 1 to 120 characters; without it, the template's title." },
          version: { type: "integer", minimum: 1, description: "The installed version to copy; without it, the installed one." },
        },
        additionalProperties: false,
      } } },
    },
    responses: {
      "201": jsonOk("#/components/schemas/TemplateCopy", "Created."),
      "400": ERROR_RESPONSE, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "404": ERROR_RESPONSE, "409": ERROR_RESPONSE,
      "413": ERROR_RESPONSE, "422": ERROR_RESPONSE, "503": ERROR_RESPONSE,
    },
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
