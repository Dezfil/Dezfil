import { ACCOUNT_ACTOR_SCHEMA, DOCUMENT_FACT_PROPERTIES, DOCUMENT_FACT_SCHEMA, editRevisionParam, editRevisionResponses } from "./openapi-document-facts";
import { mapChildren } from "./openapi-map-children";
import { mapAccess } from "./openapi-map-access";
import { authenticatedOp } from "./openapi-authenticated";
import { HISTORY_MOVE, LOCAL_READ } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { op, jsonOk, pathParam } from "./openapi-helpers";

/** The change-group marker, documented on every operation that
 * lands on the undo timeline. External tools expose the declared argument name;
 * the assistant loop owns its turn marker at the HTTP layer. */
export const changeGroupParam = {
  name: "X-Change-Group",
  "x-tool-name": "change_group",
  in: "header",
  required: false,
  schema: { type: "string", pattern: "^[\\w-]{1,64}$" },
  description:
    "Optional group marker: mutations sharing a value form one step on " +
    "the map's undo timeline and undo/redo together. The in-product " +
    "assistant stamps each turn automatically; any agent may group its " +
    "own related edits the same way.",
};

export const HISTORY_PATHS = {
      "/api/maps/{id}/history": {
        get: op(mapChildren(mapAccess({
          summary: "Undo/redo availability",
          description:
            "Whether the map currently has anything to undo or redo. Every " +
            "qualifying change (style, viz, filters, names, visibility, " +
            "layer add/delete, basemap, note, legend, layer order, timeline " +
            "dock) lands on one per-map history, whoever made it; viewport " +
            "moves, publish state, and a playing timeline do not.",
          tag: "Maps",
          tool: "get_history", mcp: LOCAL_READ,
          display: {"verb": "Read the undo state of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
          relevance: [],
          effects: READ_ONLY,
          parameters: [pathParam("id", "Map id.")],
          responses: { "200": jsonOk("#/components/schemas/History") },
        }))),
      },
      "/api/maps/{id}/undo": {
        post: op(mapChildren(mapAccess({
          summary: "Undo the newest change",
          description:
            "Reverts the latest step on the map's history. Consecutive " +
            "edits in a group form a step, and an edit from outside the " +
            "group between them starts a new one, so one turn's edits can " +
            "span several steps. Grouping never crosses actors. Restores are verbatim: exactly the values " +
            "stored before the change. Returns the refreshed map with fresh " +
            "availability and a fresh editRevision; 409 invalid_request when there is nothing to undo, " +
            "or 409 stale_revision when the seen revision is no longer current, including during SQL admission. Redo " +
            "re-applies the stored change. A replay that would change a " +
            "publication setting (the widget publication toggle or a " +
            "layer's published fields) is the map owner's alone: anyone " +
            "else is refused whole with forbidden, and nothing is restored.",
          tag: "Maps",
          tool: "undo_change", mcp: HISTORY_MOVE,
          display: {"verb": "Undid a change on the map {subject}", "subject": {"resource": "maps", "argument": "id", "name": ["name"]}},
          effects: writes(resource("maps", "id"), resource("layers")),
          parameters: [pathParam("id", "Map id."), editRevisionParam],
          responses: { ...editRevisionResponses, "200": jsonOk("#/components/schemas/MapWithHistory") },
        }))),
      },
      "/api/maps/{id}/redo": {
        post: op(mapChildren(mapAccess({
          summary: "Redo the newest undone change",
          description:
            "Re-applies the most recently undone change (or grouped turn), " +
            "exactly as it was stored. Any fresh edit after an undo " +
            "discards the redo branch. Returns a fresh editRevision, never an older token even when values match. " +
            "409 invalid_request when there is nothing to redo, or 409 stale_revision when the seen revision is no longer current, including during SQL admission. " +
            "A replay that would change a publication setting (the widget " +
            "publication toggle or a layer's published fields) is the map " +
            "owner's alone: anyone else is refused whole with forbidden, " +
            "and nothing is restored.",
          tag: "Maps",
          tool: "redo_change", mcp: HISTORY_MOVE,
          display: {"verb": "Redid a change on the map {subject}", "subject": {"resource": "maps", "argument": "id", "name": ["name"]}},
          effects: writes(resource("maps", "id"), resource("layers")),
          parameters: [pathParam("id", "Map id."), editRevisionParam],
          responses: { ...editRevisionResponses, "200": jsonOk("#/components/schemas/MapWithHistory") },
        }))),
      },
};

export const MCP_PATHS = {
      "/api/mcp": {
        post: authenticatedOp({
          summary: "MCP endpoint",
          description:
            "Model Context Protocol over the streamable HTTP transport, " +
            "stateless. Supply an account API token in Authorization: Bearer on every request. Tools use the caller’s current permissions, including admin checks. Cookie callers use a short-lived server delegation tied to their session. Every internal hop rechecks current access; credentials never enter model input or retained confirmation state. Point a token-capable MCP client at this URL to get one tool per " +
            "documented operation (the operation's x-tool name). External " +
            "agents bring their own model; no server-side model credential " +
            "is needed. The whole journey (upload, SQL, layer, style, " +
            "publish) is completable through these tools.",
          tag: "Agents",
          tool: false,
          effects: writes(resource("maps"), resource("layers"), resource("tables"), resource("publications"), resource("recipes"), resource("runs"), resource("projects"), resource("connections"), resource("palettes"), resource("settings"), resource("caches"), resource("basemaps"), resource("templates"), resource("assistant")),
          requestBody: {
            "x-byte-limit": 16_777_216,
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description: "A JSON-RPC 2.0 MCP message.",
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "JSON-RPC response, as application/json or text/event-stream.",
            },
          },
        }),
      },
};

export const HISTORY_SCHEMAS = {
        HistoryTarget: {
          type: ["object", "null"],
          properties: {
            eligible: { type: "boolean", description: "Whether the caller may replay the entire target under current edit, SQL and publication rules." },
            reason: { type: ["string", "null"], description: "The refusal reason, or null when eligible." },
            steps: { type: "array", items: { type: "object", properties: {
              id: { type: "string" }, scope: { type: "string", enum: ["map", "layer"] },
              targetId: { type: "string" }, op: { type: "string", enum: ["add", "update", "delete"] },
              createdAt: { type: "string", format: "date-time" },
              author: ACCOUNT_ACTOR_SCHEMA,
            }, required: ["id", "scope", "targetId", "op", "author", "createdAt"] } },
          }, required: ["eligible", "reason", "steps"],
        },
        History: {
    allOf: [DOCUMENT_FACT_SCHEMA],
          type: "object",
          description:
            "Undo/redo availability on the map's timeline.",
          properties: {
      ...DOCUMENT_FACT_PROPERTIES,
            canUndo: { type: "boolean" },
            canRedo: { type: "boolean" },
            undoTarget: { $ref: "#/components/schemas/HistoryTarget" },
            redoTarget: { $ref: "#/components/schemas/HistoryTarget" },
          },
          required: ["canUndo", "canRedo", "undoTarget", "redoTarget"],
        },
        MapWithHistory: {
          allOf: [
            { $ref: "#/components/schemas/MapWithLayers" },
            {
              type: "object",
              properties: {
                history: { $ref: "#/components/schemas/History" },
              },
              required: ["history"],
            },
          ],
        },
};
