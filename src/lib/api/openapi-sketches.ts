import { datasetAccess } from "./openapi-dataset-access";
import { ownedCreationOp } from "./openapi-owned-creation";
import { SKETCH_ROW_COUNT_RESPONSE } from "./openapi-tool-responses";
import { LOCAL_ADD, LOCAL_DELETE, LOCAL_READ, LOCAL_REPLACE } from "./operation-mcp";
import { READ_ONLY, writes, resource } from "./operation-metadata";
import { op, pathParam } from "./openapi-helpers";

export const SKETCH_PATHS = {
  "/api/maps/{id}/sketches": {
    get: op(datasetAccess({
      summary: "List a map's sketch datasets",
      description:
        "The sketch datasets drawn on this map, each with its " +
        "table, owning layer and per-kind feature counts — what the " +
        "builder's card copy and cascade confirmation read.",
      tag: "Sketches",
      tool: "list_map_sketches", mcp: LOCAL_READ,
      display: {"verb": "Listed the sketches of the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: READ_ONLY,
      parameters: [pathParam("id", "Map id.")],
      responses: {
        "200": {
          description: "The map's sketches.",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    table: { type: "string" },
                    tableId: { type: "string" },
                    mapId: { type: "string" },
                    layerId: { type: ["string", "null"] },
                    rowCount: { type: "integer" },
                    counts: {
                      type: "object",
                      description: "Feature count per drawn kind.",
                    },
                  },
                  required: ["table", "tableId", "mapId", "rowCount"],
                },
              },
            },
          },
        },
      },
    })),
    post: ownedCreationOp(datasetAccess({
      summary: "Start a sketch with its first feature",
      description:
        "First commit of a draw session: mints the sketch " +
        "dataset — named from the map's name plus _sketch, advancing " +
        "a visible numeric suffix on collision — and its owning layer " +
        "together, provenance recorded, no history step. The feature " +
        "passes the same structural gate as every later commit: kind " +
        "one of point, line, polygon, rectangle, circle, freehand; " +
        "geometry the kind's GeoJSON family (polygon kinds are one " +
        "closed ring, no holes); at most 10,000 vertices.",
      tag: "Sketches",
      tool: "create_sketch", mcp: LOCAL_ADD,
      display: {"verb": "Started a sketch on the map {subject}", "subject": {"resource": "maps", "argument": "id"}},
      effects: writes(resource("tables", "", "tableId"), resource("layers", "", "layerId"), resource("maps", "id")),
      parameters: [pathParam("id", "Map id.")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["feature"],
              properties: {
                feature: {
                  type: "object",
                  required: ["kind", "geometry"],
                  properties: {
                    kind: {
                      type: "string",
                      enum: [
                        "point",
                        "line",
                        "polygon",
                        "rectangle",
                        "circle",
                        "freehand",
                      ],
                    },
                    geometry: {
                      type: "object",
                      description:
                        "GeoJSON Point, LineString or Polygon " +
                        "matching the kind.",
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The minted sketch.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  table: { type: "string" },
                  tableId: { type: "string" },
                  layerId: { type: "string" },
                  layerName: { type: "string" },
                  featureId: { type: "string" },
                },
                required: ["table", "layerId", "featureId"],
              },
            },
          },
        },
        "400": { description: "The feature failed the structural gate." },
      },
    })),
  },
  "/api/sketches/{name}/features": {
    get: op(datasetAccess({
      summary: "Read a sketch's drawn features",
      description:
        "Every drawn feature with its stable id, kind and geometry " +
        "— the identity the select tool and vertex handles use.",
      tag: "Sketches",
      tool: "get_sketch_features", mcp: LOCAL_READ,
      display: {"verb": "Read the features of the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
      effects: READ_ONLY,
      parameters: [pathParam("name", "Sketch table name.")],
      responses: {
        "200": {
          description: "The features.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { features: { type: "array" } },
                required: ["features"],
              },
            },
          },
        },
      },
    })),
    post: op(datasetAccess({
      summary: "Append one drawn feature",
      description:
        "Commits one more shape into the session's dataset, " +
        "under the same structural gate and vertex ceiling as the " +
        "first. The dataset's id and name never change; the artifact " +
        "is rewritten and every dependent layer's render refreshes.",
      tag: "Sketches",
      tool: "append_sketch_feature", mcp: LOCAL_ADD,
      display: {"verb": "Added a feature to the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
      effects: writes(resource("tables", "name")),
      parameters: [pathParam("name", "Sketch table name.")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["feature"],
              properties: { feature: { type: "object" } },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The appended feature's id and the new count.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  featureId: { type: "string" },
                  rowCount: { type: "integer" },
                },
                required: ["featureId", "rowCount"],
              },
            },
          },
        },
        "400": { description: "The feature failed the structural gate." },
        "409": {
          description: "The sketch vanished mid-flight; nothing written.",
        },
      },
    })),
  },
  "/api/sketches/{name}/features/{featureId}": {
    patch: op(datasetAccess({
      summary: "Move one vertex of a drawn polygon",
      description:
        "The one permitted edit: move exactly one vertex of a " +
        "polygon or freehand feature. Kind and vertex count are " +
        "preserved; points, lines, rectangles and circles refuse; the " +
        "moved ring passes the same structural gate as a fresh commit.",
      tag: "Sketches",
      tool: "move_sketch_vertex", mcp: LOCAL_REPLACE,
      display: {"verb": "Moved a vertex of the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
      effects: writes(resource("tables", "name")),
      parameters: [
        pathParam("name", "Sketch table name."),
        pathParam("featureId", "Drawn feature id."),
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["vertexIndex", "position"],
              properties: {
                vertexIndex: {
                  type: "integer",
                  description:
                    "Ring index, 0-based, excluding the closing " +
                    "position; moving index 0 moves the closure too.",
                },
                position: {
                  type: "array",
                  description: "[longitude, latitude], in range.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": SKETCH_ROW_COUNT_RESPONSE,
        "400": { description: "Bad index or out-of-range position." },
        "409": { description: "Not a polygon-kind feature." },
      },
    })),
    delete: op(datasetAccess({
      summary: "Delete one drawn feature",
      description:
        "Removes exactly that row. The dataset keeps its id " +
        "and name; deleting the last row leaves the empty dataset " +
        "and its layer in place.",
      tag: "Sketches",
      tool: "delete_sketch_feature", mcp: LOCAL_DELETE,
      display: {"verb": "Deleted a feature of the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
      effects: writes(resource("tables", "name")),
      parameters: [
        pathParam("name", "Sketch table name."),
        pathParam("featureId", "Drawn feature id."),
      ],
      responses: {
        "200": SKETCH_ROW_COUNT_RESPONSE,
        "404": { description: "No such drawn feature." },
      },
    })),
  },
  "/api/sketches/{name}": {
    delete: op(datasetAccess({
      summary: "Delete a sketch and its owning layer — the cascade",
      description:
        "Deletes the provenance-named owning layer, its bound " +
        "widgets, the dataset, the artifact and the tile artifacts " +
        "together. Deliberately not undoable: no history step " +
        "is written and steps targeting the owner leave the timeline. " +
        "Copies and other layers over the same table keep ordinary " +
        "deletion behavior and enter the standing missing-table state.",
      tag: "Sketches",
      tool: "delete_sketch", mcp: LOCAL_DELETE,
      display: {"verb": "Deleted the sketch {subject}", "subject": {"resource": "tables", "argument": "name"}},
      effects: writes(resource("tables", "name"), resource("layers"), resource("maps")),
      parameters: [pathParam("name", "Sketch table name.")],
      responses: {
        "204": { description: "Layer and dataset are gone." },
        "404": { description: "Not a sketch dataset." },
      },
    })),
  },
};
