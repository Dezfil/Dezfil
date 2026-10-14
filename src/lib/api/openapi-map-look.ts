/**
 * The map check's schemas, out of `openapi.ts` at the feature that
 * touched them (` `, ` `).
 *
 * Two readers, one source. The check's own response says what the
 * renderer drew, and every detail list is present. A terminal recovery
 * record may have been compacted, and makes an absent list mean "detail
 * not kept" while an empty list still means a map with nothing on it — so
 * the record's render is the same schema with those three lists optional,
 * derived here rather than written twice, and the check's own response is
 * not loosened by it.
 */

const MAP_LOOK_STATE = {
  type: "object",
  description: "The bounded state identity a check's image is attributed to: what the renderer actually drew, declared by the render page itself, never a later read of the map.",
  required: ["map", "camera", "layers", "legend", "widgets", "appearance", "digest"],
  properties: {
    map: { type: "string" },
    camera: { type: "object", required: ["lng", "lat", "zoom", "pitch", "bearing"], properties: { lng: { type: "number" }, lat: { type: "number" }, zoom: { type: "number" }, pitch: { type: "number" }, bearing: { type: "number" } } },
    layers: { type: "array", description: "The visible layers drawn, each with a digest of the stored filters applied.", items: { type: "object", required: ["id", "filters"], properties: { id: { type: "string" }, filters: { type: "string" } } } },
    legend: { type: "object", required: ["visible", "corner", "order"], properties: { visible: { type: "boolean" }, corner: { type: "string" }, order: { type: "array", items: { type: "string" } } } },
    widgets: { type: "array", items: { type: "string" } },
    appearance: { type: "string", enum: ["light", "dark"] },
    digest: { type: "string", description: "A digest of the identity above." },
  },
} as const;

const MAP_LOOK_RENDER = {
  type: "object",
  description: "A check's facts: everything but the image bytes, which never enter an event or a receipt.",
  required: ["id", "mapId", "mapName", "appearance", "state", "image", "source", "attribution", "composition", "elapsedMs"],
  properties: {
    id: { type: "string", description: "The render's identity, minted per check." },
    mapId: { type: "string" },
    mapName: { type: "string" },
    appearance: { type: "string", enum: ["light", "dark"] },
    state: { $ref: "#/components/schemas/MapLookState" },
    image: { type: "object", required: ["width", "height", "bytes"], properties: { width: { type: "integer" }, height: { type: "integer" }, bytes: { type: "integer" } }, description: "The size the image was answered at and its byte count." },
    source: { type: "object", required: ["width", "height"], properties: { width: { type: "integer" }, height: { type: "integer" } }, description: "The settled render's size, from which smaller sizes are derived." },
    attribution: { type: "string", description: "The basemap credit the render carried." },
    composition: { type: "object", required: ["failures", "abandoned"], properties: { failures: { type: "array", items: { type: "string" }, description: "Truthful failures composed into the image: a failed layer, failed widget values." }, abandoned: { type: "array", items: { type: "string" }, description: "One host entry per external request abandonment, including repeated cuts of requests with no terminal event." } } },
    elapsedMs: { type: "integer" },
  },
} as const;

/** The three detail lists terminal compaction drops. */
const COMPACTED_LISTS = ["layers", "widgets"] as const;

/** `MapLookState` with those lists optional, derived so it cannot drift
 * from the state the renderer declares. */
const RECORDED_LOOK_STATE = {
  ...MAP_LOOK_STATE,
  description: `${MAP_LOOK_STATE.description} In a terminal recovery record the detail lists layers, widgets and the legend's order may be absent: the record was compacted past them and the detail was not kept. An absent list is not an empty one, which means a map with nothing of that kind drawn.`,
  required: MAP_LOOK_STATE.required.filter((key) => !(COMPACTED_LISTS as readonly string[]).includes(key)),
  properties: {
    ...MAP_LOOK_STATE.properties,
    legend: { ...MAP_LOOK_STATE.properties.legend, required: MAP_LOOK_STATE.properties.legend.required.filter((key) => key !== "order") },
  },
};

/** `MapLookRender` as a recovery record carries it. */
const RECORDED_LOOK_RENDER = {
  ...MAP_LOOK_RENDER,
  description: `${MAP_LOOK_RENDER.description} As recorded in a recovery receipt, whose state may have been compacted.`,
  properties: { ...MAP_LOOK_RENDER.properties, state: { $ref: "#/components/schemas/RecordedMapLookState" } },
};

export const MAP_LOOK_SCHEMAS = {
  MapLookState: MAP_LOOK_STATE,
  MapLookRender: MAP_LOOK_RENDER,
  RecordedMapLookState: RECORDED_LOOK_STATE,
  RecordedMapLookRender: RECORDED_LOOK_RENDER,
  MapLook: {
    type: "object",
    required: ["render", "image"],
    properties: {
      render: { $ref: "#/components/schemas/MapLookRender" },
      image: { type: "object", required: ["content_type", "width", "height", "bytes", "content_base64"], properties: { content_type: { type: "string", enum: ["image/png"] }, width: { type: "integer" }, height: { type: "integer" }, bytes: { type: "integer" }, content_base64: { type: "string", description: "The PNG, byte for byte." } } },
    },
  },
};
