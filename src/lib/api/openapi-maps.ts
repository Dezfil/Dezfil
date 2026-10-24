import { DOCUMENT_FACT_PROPERTIES, DOCUMENT_FACT_SCHEMA, editRevisionParam, conditionalMapRevisionParam, editRevisionResponses } from "./openapi-document-facts";
import { FILING_DESTINATION } from "./openapi-project-access";
import { resultAccess } from "./openapi-result-access";
import { mapChildren } from "./openapi-map-children";
import { layerAccess } from "./openapi-layer-access";
import { mapAccess } from "./openapi-map-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { authenticatedOp } from "./openapi-authenticated";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE, MAP_LOOK, REMOTE_READ, REMOTE_REPLACE } from "./operation-mcp";
import { changeGroupParam } from "./openapi-mcp";
import { READ_ONLY, writes, resource, recorded } from "./operation-metadata";
import { ERROR_RESPONSE, op, jsonOk, pathParam } from "./openapi-helpers";
import { PROJECT_SCOPE_PARAM } from "./openapi-projects";

/** A card image's theme: a map whose basemap follows the
 * theme carries one image per theme; every other map keeps one image
 * that answers both. */
const THUMBNAIL_THEME_PARAM = {
  name: "theme",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["light", "dark"] },
  description:
    'The viewer\'s theme, "light" or "dark". Any other value is refused.',
};
const PICTURE_SHAPE_PARAM = {
  name: "shape",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["card", "wide"] },
  description:
    'The shape to answer. The server keeps every picture in one shape, ' +
    'which "card" and "wide" both name; a picture kept earlier in two ' +
    'shapes answers the one named until it is made again. Any other ' +
    "value is refused.",
};
const PICTURE_WIDTH_PARAM = {
  name: "width",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: 999999999 },
  description:
    "The width in screen pixels the image will cover. Anything but a " +
    "positive whole number is refused.",
};

export const MAP_COLLECTION_PATHS = {
  "/api/maps": {
    get: op(mapAccess({
      summary: "List maps",
      tag: "Maps",
      tool: "list_maps", mcp: LOCAL_READ,
      display: {"verb": "Listed the maps"},
      effects: READ_ONLY,
      parameters: [PROJECT_SCOPE_PARAM],
      responses: { "200": jsonOk("#/components/schemas/MapList") },
    })),
    post: ownedCreationOp(mapAccess({
      summary: "Create a map",
      description:
        "Optionally filed into a project at birth: an " +
        "unknown project refuses and creates nothing. A new map takes " +
        "the instance's defaults for its basemap, starting view and " +
        "legend corner (`defaults` in the runtime configuration).",
      tag: "Maps",
      tool: "create_map", mcp: LOCAL_ADD,
      display: {"verb": "Created the map {subject}", "subject": {"resource": "maps", "result": "id", "name": ["name"]}},
      effects: writes(resource("maps", "", "id"), resource("projects")),
      requestBody: {
        "x-byte-limit": 16_777_216,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                projectId: {
                  type: ["string", "null"],
                  description:
                    "The project the new map joins; omitted or null, " +
                    "it starts unfiled." + FILING_DESTINATION,
                },
              },
            },
            example: { name: "My map" },
          },
        },
      },
      responses: { "201": jsonOk("#/components/schemas/MapCreated", "Created.") },
    })),
  },
};

export const MAP_RESOURCE_PATHS = {
  "/api/maps/{id}": {
    get: op(mapAccess({
      summary: "Read a map with its layers",
      tag: "Maps",
      tool: "get_map", mcp: LOCAL_READ,
      display: {"verb": "Read the map {subject}", "subject": {"resource": "maps", "argument": "id", "name": ["name"]}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "200": jsonOk("#/components/schemas/MapWithLayers"),
      },
    })),
    patch: op(layerAccess(mapAccess({
      summary: "Update a map",
      description:
        "Any of name, viewport, basemap (dark | light | streets | " +
        "satellite, or null for Auto — the builder follows the app " +
        "theme; published views follow the publication's effective " +
        "theme, unless a deployment override pins Auto), " +
        "basemapLayers (per-group basemap " +
        "visibility; null shows everything), legendCorner (null = " +
        "bottom-left), legendOrder (the manual legend arrangement; " +
        "null follows the layer panel), timeline " +
        "(the docked playback timeline; null undocks), " +
        "widgets (the ordered widget list, notes included), " +
        "widgetsPublished (whether widgets ship with the " +
        "published view), or layer order. The former `note` field " +
        "retired into a note widget.",
      tag: "Maps",
      tool: "update_map", mcp: REMOTE_REPLACE,
      display: {"verb": "Updated the map {subject}", "subject": {"resource": "maps", "argument": "id", "name": ["name"]}},
      effects: recorded(writes(resource("maps", "id"))),
      parameters: [pathParam("id", "Map id."), changeGroupParam, conditionalMapRevisionParam],
      requestBody: {
        "x-byte-limit": 16_777_216,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/MapUpdate" },
            example: { viewport: { lng: 13.4, lat: 52.5, zoom: 10 } },
          },
        },
      },
      responses: { ...editRevisionResponses,
        "200": jsonOk("#/components/schemas/MapWithLayers"),
      },
    }))),
    delete: op(mapAccess({
      summary: "Delete a map",
      tag: "Maps",
      tool: "delete_map", mcp: LOCAL_DELETE,
      display: {"verb": "Deleted the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: writes(resource("maps", "id"), resource("layers"), resource("publications", "id"), resource("projects")),
      confirmation: {"target": "Delete {target}?", "consequence": "This deletes the map and its layers and stops its published link.", "subject": {"path": "/api/maps/{id}", "argument": "id", "name": "name"}},
      confirm: true,
      parameters: [pathParam("id", "Map id."), editRevisionParam],
      responses: { ...editRevisionResponses, "204": { description: "Deleted." } },
    })),
  },
  "/api/maps/{id}/picture/refresh": {
    post: op(mapAccess({
      summary: "Refresh a map picture",
      description: "Ask the server to picture the saved drawing as its owner. The owner or a project Editor may ask; a Viewer receives forbidden. Repeated requests coalesce with pending work. The previous complete picture stays served. This changes no edit revision, history or Last edited timestamp and requires no edit revision. Answers queued after admission to the quiet wait, or unavailable when the renderer is absent. Basemap services may be contacted by the background attempt.",
      tag: "Maps", tool: "refresh_map_picture", mcp: MAP_LOOK,
      display: { verb: "Requested a map picture" }, effects: writes(resource("maps", "id")),
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "202": { description: "Queued or coalesced.", content: { "application/json": { schema: { type: "object", properties: { outcome: { type: "string", const: "queued" }, pictureState: { type: "string", const: "waiting" } }, required: ["outcome", "pictureState"] } } } },
        "200": { description: "The renderer is unavailable.", content: { "application/json": { schema: { type: "object", properties: { outcome: { type: "string", const: "unavailable" }, pictureState: { type: "string", const: "unavailable" } }, required: ["outcome", "pictureState"] } } } },
        "403": ERROR_RESPONSE,
      },
    })),
  },
  "/api/maps/{id}/thumbnail": {
    get: op(mapChildren(mapAccess({
      summary: "Read a map's snapshot",
      description:
        "The last complete PNG the server made for this map, the " +
        "maps screen's card image. 404 while no picture is served. A map " +
        "whose basemap follows the theme carries one image per theme: " +
        "name the theme to read that one. The fallback order: " +
        "the named theme's image, then the map's single image, then " +
        "the other theme's; a request naming no theme answers the " +
        "light image, then dark, then the single image. An image the " +
        "reader may not be served (one that drew a dataset beyond their " +
        "reach, or an unattributed one read by anyone but the owner) is " +
        "passed over like a missing one; when none is left the answer is " +
        "the same 404 as for a map with no image at all. The maps " +
        "listing's `hasThumbnail` says beforehand whether there is one. " +
        "Naming a shape or a width answers one of the sizes the server " +
        "keeps of that picture, as WebP: the narrowest at least that " +
        "wide, else the widest; a shape alone answers the widest. The " +
        "sizes share one proportion, 968 by 494, which a card's box " +
        "crops to its own; a picture kept earlier in two shapes answers " +
        "the one named, and a width alone its card shape. A picture " +
        "made before sizes were kept answers its PNG whatever is named. " +
        "Every answer carries an entity tag of its bytes and " +
        "`Cache-Control: private, no-cache`, so a client may keep it but " +
        "asks again before each use; a request whose `If-None-Match` " +
        "names the current tag is answered 304 without the bytes, after " +
        "the same serving checks as a full read.",
      tag: "Maps",
      // UI sugar, not a map capability — outside the agent tool set.
      tool: false,
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id."), THUMBNAIL_THEME_PARAM, PICTURE_SHAPE_PARAM, PICTURE_WIDTH_PARAM],
      responses: {
        "200": {
          description: "The snapshot: the PNG, or with a shape or a width named, a kept size.",
          headers: {
            ETag: { description: "The entity tag of these bytes.", schema: { type: "string" } },
            "Cache-Control": { description: "private, no-cache", schema: { type: "string", const: "private, no-cache" } },
          },
          content: {
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/webp": { schema: { type: "string", format: "binary" } },
          },
        },
        "304": { description: "The picture this reader is served is unchanged: its entity tag matches If-None-Match." },
        "400": { ...ERROR_RESPONSE, description: "A theme, shape or width the read does not take (invalid_request)." },
        "404": { description: "No snapshot yet." },
      },
    }))),
    put: op(mapChildren(mapAccess({
      summary: "Refuse a retired browser picture upload",
      description: "Compatibility change: this operation no longer accepts browser pixels. An authorized owner receives 410 picture_upload_retired without the handler reading the body or changing any image. Use POST /api/maps/{id}/picture/refresh. Theme, cycle and revision query values do not restore the former operation.",
      tag: "Maps", tool: false, effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: { "410": { ...ERROR_RESPONSE, description: "Browser picture upload retired (picture_upload_retired)." }, "403": ERROR_RESPONSE },
    }))),
  },
  "/api/maps/{id}/widget-values": {
    post: op(layerAccess(mapAccess({
      summary: "Read the map's widget values",
      description:
        "Every visible widget computed server-side over its layer's " +
        "effective query, under an optional ephemeral " +
        "selection set — cross-filter state that lives on the request " +
        "and is never stored. Classic crossfilter semantics: a widget's " +
        "own selection never filters itself. Also returns per-layer " +
        "constrained/total row counts. A read, despite the POST — the " +
        "body carries the selections. An optional draft widget" +
        " previews an unsaved editor state: validated like a " +
        "stored widget, it replaces its stored self by id (or joins as " +
        "a new card) for this computation only — nothing is written.",
      tag: "Maps",
      tool: "read_widget_values", mcp: LOCAL_READ,
      display: {"verb": "Read the widget values of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      relevance: [],
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                selections: {
                  $ref: "#/components/schemas/WidgetSelections",
                },
                draft: {
                  $ref: "#/components/schemas/MapWidget",
                },
              },
            },
            example: {
              selections: [
                { widgetId: "w1", kind: "exclude", values: ["Nordend"] },
              ],
            },
          },
        },
      },
      responses: { "200": jsonOk("#/components/schemas/WidgetValues") },
    }))),
  },
  "/api/maps/{id}/search": {
    get: op(mapAccess({
      summary: "Search the map",
      description:
        "One search over the map's own data and, on request, places " +
        ": visible layers matched by name, attribute values " +
        "matched case-insensitively in genuine text columns of each " +
        "visible layer's effective (filtered) result — one row per " +
        "matching feature, at most 20 across layers, on the hardened " +
        "read-only path — and every plausible reading of a pasted " +
        "decimal coordinate pair. With `places=1` and a configured " +
        "provider endpoint, Nominatim-compatible place results join, " +
        "carrying the provider's attribution; unconfigured, the places " +
        "group answers `unconfigured` and everything local still " +
        "works. Value and place rows carry the geometry a client needs " +
        "to fly or fit without a second request. Never builder actions.",
      tag: "Maps",
      tool: "search_map", mcp: REMOTE_READ,
      display: {"verb": "Searched the map {subject} for {arg.q}", "subject": {"resource": "maps", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [
        pathParam("id", "Map id."),
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "The search text.",
        },
        {
          name: "places",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["1"] },
          description:
            "Ask for places too — the submitted search. Omitted, the " +
            "provider is never contacted (the per-keystroke path).",
        },
      ],
      responses: { "200": jsonOk("#/components/schemas/SearchResults") },
    })),
  },
  "/api/maps/{id}/dependencies": {
    get: op(mapAccess({
      summary: "The datasets a map draws from",
      description:
        "Each layer's references resolve to dataset identities in the map's SQL home within the caller's reach, and each one is listed with its owner and the name the caller would type: a dataset the caller cannot reach is left out rather than named, and a same-named dataset of the caller's own never stands in for the map's. Memberships name the projects the caller reaches, and on the caller's own datasets every project they are in, one the caller no longer reaches included; producers only workflows the caller reaches, each marked with whether the caller owns it. " +
        "The 14-A filing checklist's subject: every " +
        "registered dataset used by at least one of the map's saved " +
        "layers, exactly once, with its source, row count, project " +
        "memberships, and the workflow-origin recipe that currently " +
        "produces it (null otherwise), and its geometry column and " +
        "sampled geometry type (both null for a non-spatial dataset; " +
        "a column with no sampled type is still spatial). A layer whose " +
        "statement cannot be analyzed fails the whole read with " +
        "`dependencies_unresolved` — a partial answer never presents " +
        "as a complete checklist.",
      tag: "Maps",
      tool: "get_map_dependencies", mcp: LOCAL_READ,
      display: {"verb": "Read the datasets of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "200": jsonOk("#/components/schemas/MapDependencies"),
      },
    })),
  },
  "/api/maps/{id}/duplicate": {
    post: ownedCreationOp(mapAccess({
      summary: "Duplicate a map",
      description:
        "Full copy — viewport, basemap, note, legend, timeline dock, and " +
        "every layer under fresh ids — named \"<name> copy\", always an " +
        "unpublished draft. Edit history does not carry over.",
      tag: "Maps",
      tool: "duplicate_map", mcp: LOCAL_ADD,
      display: {"verb": "Duplicated a map as {subject}", "subject": {"resource": "maps", "result": "id", "name": ["name"]}},
      effects: writes(resource("maps", "", "id"), resource("layers"), resource("projects")),
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "201": jsonOk("#/components/schemas/MapWithLayers", "Created."),
      },
    })),
  },
};

export const MAP_RENDER_PATHS = {
  "/api/maps/look": {
    post: authenticatedOp(resultAccess(mapAccess({
      summary: "Look at a map: one bounded rendered image with its facts",
      description:
        "The model-facing check of a map: the map's stored " +
        "state rendered through the same server-side road as the image " +
        "export, at 1024 by 640 pixels, and answered as a PNG of at most " +
        "384 KiB together with the render's facts. The image is derived " +
        "from that one render downwards through 768 by 480 and 512 by 320 " +
        "when the byte bound is missed; still over it at 512 by 320 the " +
        "answer is look_image_too_large and no image. The facts carry the " +
        "render's identity, the bounded state identity of what the renderer " +
        "actually drew (the map, the camera, the visible layers with a digest " +
        "of their stored filters, the legend and the widgets, the appearance), " +
        "the image's pixel and byte sizes, the source size, the attribution " +
        "credited, the composition's truthful failures and any abandoned " +
        "external requests, and the elapsed time. The appearance is an " +
        "explicit input, light when absent; mapId names the map, and a call " +
        "naming none answers look_target_missing. Read-only: the map's stored " +
        "state stays as it is; the image is retained in process for " +
        "GET /api/maps/look/{renderId} under documented bounds. Bounded by " +
        "its own budget (30 s by default, DEZFIL_ASSISTANT_LOOK_TIMEOUT_S), " +
        "queue wait, render and image preparation included; past it the " +
        "answer is render_timeout. Without a renderer browser on the " +
        "instance the answer is render_unavailable.",
      tag: "Maps",
      tool: "look_at_map", mcp: MAP_LOOK,
      toolOutput: { binary: { representation: "json-image", nativeImage: false } },
      display: {"verb": "Checked the map"},
      effects: READ_ONLY,
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                mapId: { type: "string", description: "The map to look at. The assistant supplies the contextual map when the model names none; a headless call without one answers look_target_missing." },
                appearance: { type: "string", enum: ["light", "dark"], description: "The theme to render with. Light when absent." },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonOk("#/components/schemas/MapLook", "The image and the render's facts."),
        "400": { description: "No map named (look_target_missing), or a malformed map id or appearance (invalid_request)." },
        "404": { description: "No such map (not_found)." },
        "408": { description: "The check's budget was exceeded (render_timeout)." },
        "413": { description: "No image fits the byte bound at any documented size (look_image_too_large)." },
        "502": { description: "The render failed or the renderer did not report what it drew (render_failed)." },
        "503": { description: "No renderer browser on this instance (render_unavailable)." },
      },
    }))),
  },
  "/api/maps/look/{renderId}": {
    get: authenticatedOp(resultAccess({
      summary: "Read the retained image of a map check",
      description:
        "Exactly the PNG a check handed the model, or " +
        "the thumbnail derived from it at retention, as an attachment. " +
        "Renders are retained in process under documented bounds, 256 " +
        "renders and 96 MiB by default (DEZFIL_ASSISTANT_LOOK_RETENTION, " +
        "DEZFIL_ASSISTANT_LOOK_RETENTION_MB), full images and thumbnails " +
        "counted together, oldest evicted first, gone with the process. " +
        "After eviction or a restart the answer is look_image_unavailable; " +
        "this read renders nothing.",
      tag: "Maps",
      tool: "read_map_look_image", mcp: LOCAL_READ,
      toolOutput: { binary: { representation: "attachment", nativeImage: true } },
      display: {"verb": "Read the image of a map check"},
      relevance: [],
      effects: READ_ONLY,
      parameters: [
        pathParam("renderId", "The render's identity from the check's facts."),
        { name: "variant", in: "query", required: false, schema: { type: "string", enum: ["full", "thumbnail"] }, description: "full (the default) is the image the model was given; thumbnail is the 132 px wide derivation kept beside it." },
      ],
      responses: {
        "200": { description: "The PNG, as an attachment.", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
        "404": { description: "Evicted or gone with a restart (look_image_unavailable)." },
      },
    })),
  },
  "/api/maps/{id}/export/image": {
    post: authenticatedOp(resultAccess(mapAccess({
      summary: "Render a map to a PNG image",
      description:
        "Server-side image export: the map rendered by " +
        "the app's own client inside the instance's headless browser " +
        "and screenshotted at exactly the definition's pixels — the " +
        "same composition the builder's export card downloads, " +
        "pixel-faithful by construction. Takes the documented " +
        "ExportImageDefinition; answers the PNG as an attachment " +
        "(agents receive it as the base64 attachment envelope). " +
        "Bounded by the documented render budget and concurrency " +
        "cap; renders stored map state — visible layers, stored " +
        "filters — never builder-transient selections. Without a " +
        "browser on the instance the operation answers " +
        "render_unavailable; health is unaffected. When an external " +
        "request outlives its bound, the request burst has settled and " +
        "no app-origin request remains in flight, the relay ends its " +
        "current sockets and refuses re-dials only to the stalled hosts for " +
        "this render. Requests without a terminal event stay armed for another " +
        "cut after the same bound. The whole render budget still applies. " +
        "An image response carries x-dezfil-export-abandoned with the " +
        "abandonment count and hosts (never paths), counting repeated cuts " +
        "again. The server log names each abandonment as it happens.",
      tag: "Maps",
      tool: "export_map_image", mcp: REMOTE_READ,
      toolOutput: { binary: { representation: "attachment", nativeImage: false } },
      display: {"verb": "Rendered the map {subject} to an image", "subject": {"resource": "maps", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["definition"],
              properties: {
                definition: {
                  $ref: "#/components/schemas/ExportImageDefinition",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The PNG, as an attachment.",
          content: {
            "image/png": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "400": {
          description: "Invalid definition (schema-validated).",
        },
        "503": {
          description: "No renderer browser on this instance.",
        },
      },
    }))),
  },
};

export const MAP_PUBLISH_PATHS = {
  "/api/maps/{id}/publish": {
    get: op(mapAccess({
      summary: "The active publication's authored settings",
      description:
        "The theme default and the viewer-controls checklist for the " +
        "active publication. 204 when the map is not " +
        "published — a state, not an error. A map record carries no " +
        "publication state, so this is how an author surface reads " +
        "back what it is about to change. The token is the map owner's " +
        "alone: anyone else who reaches the map reads the settings " +
        "without it.",
      tag: "Publish",
      tool: "get_publication_state", mcp: LOCAL_READ,
      display: {"verb": "Read the publication of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "200": jsonOk(
          "#/components/schemas/PublicationState",
          "The active publication's settings.",
        ),
        "204": { description: "The map is not published." },
      },
    })),
    post: op(mapAccess({
      summary: "Publish a map",
      description:
        "Minting a publication and changing its theme or reader " +
        "controls are the map owner's alone. " +
        "Returns a stable, unguessable token. Idempotent while " +
        "published. The optional `theme` (\"light\" | \"dark\") " +
        "sets the published view's authored default: omitted on " +
        "a first publication it records dark (existing callers keep " +
        "their behavior); stated while already published it updates " +
        "the stored default in place — the token never changes for a " +
        "theme; omitted while published it changes nothing. The " +
        "optional `viewerControls` sets which optional " +
        "reader controls the publication exposes, on the same in-place " +
        "rule: omitted it changes nothing, and on a publication that " +
        "never stated one every control is on. Within a stated set an " +
        "omitted member reads as enabled. The two settings are " +
        "independent — stating one never rewrites the other. " +
        "Unpublishing clears both with the token.",
      tag: "Publish",
      tool: "publish_map", mcp: LOCAL_REPLACE,
      display: {"verb": "Published the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: writes(resource("publications", "id")),
      confirmation: {"target": "Publish {target}?", "consequence": "Anyone with the link can view its published data.", "subject": {"path": "/api/maps/{id}", "argument": "id", "name": "name"}},
      confirm: true,
      parameters: [pathParam("id", "Map id."), editRevisionParam],
      requestBody: {
        "x-byte-limit": 16_777_216,
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                theme: {
                  type: "string",
                  enum: ["light", "dark"],
                  description:
                    "The authored default theme for readers" +
                    ".",
                },
                viewerControls: {
                  $ref: "#/components/schemas/ViewerControls",
                },
              },
            },
          },
        },
      },
      responses: { ...editRevisionResponses, "201": jsonOk("#/components/schemas/PublishState", "Published.") },
    })),
    delete: op(mapAccess({
      summary: "Unpublish a map",
      description: "The link stops resolving immediately. Revoking a publication is the map owner's alone.",
      tag: "Publish",
      tool: "unpublish_map", mcp: LOCAL_REPLACE,
      display: {"verb": "Unpublished the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: writes(resource("publications", "id")),
      confirmation: {"target": "Unpublish {target}?", "consequence": "Its published link will stop working.", "subject": {"path": "/api/maps/{id}", "argument": "id", "name": "name"}},
      confirm: true,
      parameters: [pathParam("id", "Map id."), editRevisionParam],
      responses: { ...editRevisionResponses, "200": jsonOk("#/components/schemas/EditRevisionResult", "Unpublished. The surviving map revision.") },
    })),
  },
  "/api/maps/{id}/published-fields": {
    get: op(mapAccess({
      summary: "What each layer shares when this map is published",
      description:
        "The shared-field statement: per layer, the " +
        "effective published field set — fields marked `required` are " +
        "what the published map cannot render without and publish " +
        "regardless of any list — the mode (derived | list), and every " +
        "field an explicit list could name. The publish surface " +
        "renders exactly this; the wire carries exactly what it " +
        "states. A layer whose SQL cannot resolve degrades to a " +
        "per-layer error while the rest answer.",
      tag: "Publish",
      tool: "get_published_fields", mcp: LOCAL_READ,
      display: {"verb": "Read the published fields of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      relevance: [],
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "200": jsonOk("#/components/schemas/PublishedFieldsStatement"),
      },
    })),
  },
};

export const MAP_DEPENDENCY_SCHEMAS = {
  MapDependencies: {
    type: "object",
    properties: {
      ...DOCUMENT_FACT_PROPERTIES,
      datasets: {
        type: "array",
        description:
          "The distinct registered datasets the map's layers read, " +
          "alphabetical by the name the caller would type.",
        items: { $ref: "#/components/schemas/DependencyDataset" },
      },
    },
    required: ["datasets"],
  },
};

export const MAP_SCHEMAS = {
  ResourceOwner: {
    type: "object",
    description:
      "A person a resource names: its owner, or the account whose SQL " +
      "home it is. The display name and the SQL name, never an email.",
    properties: {
      name: { type: "string" },
      sqlName: {
        type: "string",
        description: "The person's SQL name, the qualifier other people's SQL uses for their datasets.",
      },
    },
    required: ["name", "sqlName"],
  },
  MapPresence: {
    type: "object",
    description:
      "What every map read and listing carries beyond the stored map, " +
      "the same for the caller's own maps as for maps shared with them. " +
      "Never part of the published view.",
    properties: {
      projectId: {
        type: ["string", "null"],
        description:
          "The project this map is in: on the caller's own map always, " +
          "a project they no longer reach included (they withdraw it " +
          "with PATCH /api/projects/{id}/members), and on anyone else's " +
          "the project through which the caller reaches it; null = in " +
          "no project.",
      },
      owner: {
        $ref: "#/components/schemas/Person",
        description: "The map's owner.",
      },
      home: {
        type: "string",
        description:
          "The SQL name of the map's SQL home: the account whose " +
          "datasets its plain table names mean, whoever reads it. Fixed " +
          "at creation; duplication and transfer keep it.",
      },
    },
    required: ["projectId", "owner", "home"],
  },
  MapCreated: {
    allOf: [
      { $ref: "#/components/schemas/Map" },
      { $ref: "#/components/schemas/MapPresence" },
    ],
  },
  Map: {
    allOf: [DOCUMENT_FACT_SCHEMA],
    type: "object",
    properties: {
      ...DOCUMENT_FACT_PROPERTIES,
      id: { type: "string" },
      name: { type: "string" },
      viewport: { $ref: "#/components/schemas/Viewport" },
      basemap: {
        type: ["string", "null"],
        description:
          "dark | light | streets | satellite; null is Auto — the " +
          "builder follows the app theme (a deployment basemap " +
          "override pins it), and published views render the " +
          "deployment default.",
      },
      customBasemap: {
        $ref: "#/components/schemas/CustomBasemap",
        description:
          "The map's custom basemap style; null = none. " +
          "When set it wins over the key in every surface; the key " +
          "survives underneath and returns when this clears.",
      },
      basemapLayers: { $ref: "#/components/schemas/BasemapLayers" },
      note: {
        $ref: "#/components/schemas/MapNote",
        description:
          "Legacy: always null — the map's old note field " +
          "migrated into a note widget. Kept for pre-migration " +
          "undo images.",
      },
      legendCorner: { $ref: "#/components/schemas/LegendCorner" },
      legendOrder: { $ref: "#/components/schemas/LegendOrder" },
      timeline: { $ref: "#/components/schemas/MapTimeline" },
      widgets: { $ref: "#/components/schemas/WidgetList" },
      widgetsPublished: {
        type: "boolean",
        description:
          "Whether widgets ship with the published view.",
      },
      publishToken: {
        type: ["string", "null"],
        description:
          "The published link's token, the map owner's alone: null to " +
          "anyone else who reaches the map, and null while unpublished. " +
          "Handing the link out is publishing, which stays the owner's act.",
      },
      publishedAt: { type: ["string", "null"] },
      published: {
        type: "boolean",
        description:
          "Whether a publication is live, for everyone who reaches the " +
          "map; `publishedAt` says since when.",
      },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
  },
  MapOverview: {
    allOf: [
      { $ref: "#/components/schemas/Map" },
      {
        type: "object",
        properties: {
          projectId: {
            type: ["string", "null"],
            description:
              "The project this map is in: on the caller's own map " +
              "always, a project they no longer reach included, and on " +
              "anyone else's the project through which the caller " +
              "reaches it; null = in no project. Never part of " +
              "the published view.",
          },
          layerCount: { type: "integer" },
          layerColors: {
            type: "array",
            items: { type: "string" },
            description:
              "One representative CSS color per layer, in draw " +
              "order — what the maps screen renders as layer dots.",
          },
          pictureState: { type: "string", enum: ["current", "waiting", "failed", "unsupported", "unavailable"], description: "The server picture work state. It names no dataset or private reason, even when this reader cannot be served the picture." },
          pictureVersion: { type: ["string", "null"], description: "An opaque version of the served picture for the image URL v parameter. Changes when a new complete picture lands, including data-only and requested refreshes. Null when no picture is served." },
          hasThumbnail: {
            type: "boolean",
            description:
              "Whether the map has a card image the caller is served: " +
              "GET /api/maps/{id}/thumbnail answers one. False until the " +
              "server first pictures the map, and while every image it " +
              "has drew a dataset beyond the caller's reach. A card asks " +
              "for the image only when this is true.",
          },
          thumbnailBasemap: {
            type: ["object", "null"],
            description:
              "The basemap that card image was drawn on, recorded when the " +
              "image was saved: the style's address, its kind, whether the " +
              "map's own style (a library or single-map style) drew it " +
              "rather than one of the instance's, and the credit it " +
              "claimed then. A page of card images credits their basemaps " +
              "from it, so an image keeps its credit when the map, the " +
              "imagery or the instance's styles change, until the map is " +
              "captured again. Null while hasThumbnail is false, and for " +
              "an image that recorded none (one saved before images " +
              "recorded it, or a picture of a template on Satellite, whose " +
              "template names no imagery), which is credited by the map's " +
              "basemap now.",
            properties: {
              url: { type: "string" },
              kind: { type: "string", enum: ["vector", "imagery"] },
              custom: { type: "boolean" },
              attribution: { $ref: "#/components/schemas/BasemapAttribution" },
            },
            required: ["url", "kind", "custom", "attribution"],
          },
        },
      },
      { $ref: "#/components/schemas/MapPresence" },
    ],
  },
  MapList: {
    type: "array",
    items: { $ref: "#/components/schemas/MapOverview" },
  },
};

export const MAP_DETAIL_SCHEMAS = {
  MapWithLayers: {
    allOf: [
      { $ref: "#/components/schemas/Map" },
      {
        type: "object",
        properties: {
          projectId: {
            type: ["string", "null"],
            description:
              "The project this map is in: on the caller's own map " +
              "always, a project they no longer reach included, and on " +
              "anyone else's the project through which the caller " +
              "reaches it; null = in no project. Detail reads " +
              "carry it; the published surfaces never do.",
          },
        },
      },
      { $ref: "#/components/schemas/MapPresence" },
      {
        type: "object",
        properties: {
          layers: { $ref: "#/components/schemas/LayerList" },
        },
      },
    ],
  },
  MapUpdate: {
    type: "object",
    properties: {
      name: { type: "string" },
      viewport: { $ref: "#/components/schemas/Viewport" },
      basemap: {
        type: ["string", "null"],
        description:
          "dark | light | streets | satellite; null returns the map " +
          "to Auto (follows the app theme in the builder; published " +
          "views use the deployment default).",
      },
      customBasemap: {
        type: ["object", "null"],
        description:
          "Set or replace the map's custom basemap style" +
          "; null removes it and reveals the stored key again. " +
          "The server inspects the URL before saving: a valid style " +
          "saves with its attribution snapshot; unreachable or " +
          "policy-blocked URLs save only with force: true (every " +
          "reader's browser fetches the style itself, so they may " +
          "still work); non-style URLs never save. " +
          "{ libraryStyle } takes a style the instance's basemap " +
          "library offers, by its id (GET /api/config lists them as " +
          "basemapStyles): the map keeps its own copy of the style's " +
          "name, address and credit, nothing is fetched, and hiding or " +
          "removing the style later changes no map. A hidden or unknown " +
          "id is refused. While the basemaps.singleMapStyles setting is " +
          "off, a url the library does not offer is refused with " +
          "basemap_not_offered, before it is read, unless the map already " +
          "holds it.",
        anyOf: [{ required: ["url"] }, { required: ["libraryStyle"] }],
        properties: {
          libraryStyle: {
            type: "string",
            description:
              "A basemap library style's id; given alone, without url, " +
              "name or force.",
          },
          url: { type: "string" },
          name: {
            type: ["string", "null"],
            description:
              "Display name for the picker tile; absent shows the " +
              "URL's hostname.",
          },
          force: {
            type: "boolean",
            description:
              "Save despite an unreachable or blocked verdict.",
          },
        },
      },
      basemapLayers: { $ref: "#/components/schemas/BasemapLayers" },
      legendCorner: { $ref: "#/components/schemas/LegendCorner" },
      legendOrder: { $ref: "#/components/schemas/LegendOrder" },
      timeline: { $ref: "#/components/schemas/MapTimeline" },
      widgets: { $ref: "#/components/schemas/WidgetList" },
      widgetsPublished: {
        type: "boolean",
        description:
          "Whether widgets ship with the published view. A publication " +
          "setting: only the map's owner changes it, and anyone else's " +
          "write that would change it is refused whole with forbidden.",
      },
      layerOrder: {
        type: "array",
        items: { type: "string" },
        description:
          "All the map's layer ids, bottom to top — the draw order.",
      },
    },
  },
};
