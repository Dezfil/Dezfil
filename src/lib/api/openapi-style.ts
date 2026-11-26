/**
 * The layer style in the API description, in the two forms the contract
 * holds it: as a write accepts it (`StyleInput`, the body of a layer's
 * create and update) and as an answer carries it (`Style`, every layer the
 * API returns). Both share every property definition; they differ only in
 * what the label requires. A write may leave the label's paint out, and
 * the text and halo then follow the map; an answer always carries both
 * choices and the concrete colours beside them, because the generated
 * tools check every answer against the shape published here.
 */

const choice = (part: string, members: string, write: string) => ({
  type: "string",
  enum: ["automatic", "own"],
  description:
    `How the label's ${part} is painted. "automatic" follows the tone of ` +
    "the basemap drawn under the label: dark text on a white halo over " +
    "light basemaps, light text on a dark halo over dark ones and imagery. " +
    `"own" draws ${members}. In a write, ${write} An explicit "automatic" ` +
    "overrides the values sent beside it, which are still checked. Every " +
    "answer carries it.",
});

const LABEL_PROPERTIES = {
  attribute: {
    type: "string",
    description:
      "Label source column; omit on aggregated layers.",
  },
  size: {
    type: "number",
    description:
      "Text size, 1-72; 12 is a good default. On simple " +
      "layers this is screen pixels. On hex/grid layers it " +
      "scales the label's proportion of its cell — cell " +
      "labels zoom with the map, like the cells themselves.",
  },
  textPaint: choice(
    "text",
    "`color`",
    "absent with no `color` means automatic, and absent with a `color` " +
      "means the label's own.",
  ),
  color: {
    type: "object",
    description:
      "Text color {r, g, b, a}: the label's own with `textPaint` " +
      '"own". With "automatic", answers carry the fallback described on ' +
      "the label.",
  },
  haloPaint: choice(
    "halo",
    "`haloWidth` and `haloColor`",
    "absent with neither of the two means automatic, and absent with " +
      'both means the label\'s own; one of them alone without a choice is ' +
      'refused, and so is "own" without both.',
  ),
  haloWidth: {
    type: "number",
    description:
      "Halo rim behind the text, 0 (none) to 3 (widest). " +
      "Replaced the legacy " +
      "`halo` boolean: stored maps migrate on " +
      "read; writes stating the boolean answer " +
      "invalid_request.",
  },
  haloColor: {
    type: "object",
    description: "Halo color {r, g, b, a}.",
  },
  weight: {
    type: "string",
    enum: ["normal", "bold"],
    description: "Absent = normal.",
  },
  anchor: {
    type: "string",
    description:
      "One of the nine compass positions plus center, " +
      "relative to the feature's anchor point; absent = " +
      "center.",
  },
  offsetX: {
    type: "number",
    description: "Pixels, -50 to 50; +x right. Absent = 0.",
  },
  offsetY: {
    type: "number",
    description: "Pixels, -50 to 50; +y down. Absent = 0.",
  },
  rotation: {
    type: "number",
    description:
      "Degrees, -180 to 180, counter-clockwise positive. " +
      "Absent = 0.",
  },
  textCase: {
    type: "string",
    enum: ["as-is", "upper", "lower"],
    description: "Applied before truncation. Absent = as-is.",
  },
  maxChars: {
    type: ["number", "null"],
    description:
      "Truncate to N code points with an ellipsis (not " +
      "counted), 1 to 80; null/absent = no truncation.",
  },
  density: {
    type: "number",
    description:
      "Collision-culling density, 0 sparse to 1 " +
      "dense; absent = 0.5. Table-backed layers only — tiled " +
      "layers are exempt from thinning.",
  },
  zoomFloor: {
    type: ["number", "null"],
    description:
      "Show labels from this whole zoom level (0-24); " +
      "null/absent = no floor.",
  },
  priorityField: {
    type: ["string", "null"],
    description:
      "Numeric column ranking which labels survive the cap " +
      "and collisions (higher wins; nulls last); null/absent " +
      "= stable feature order. Published maps carry the " +
      "column's values.",
  },
  cap: {
    type: ["number", "null"],
    description:
      "Draw at most N labels (1-10000), after ranking; " +
      "null/absent = no cap.",
  },
};

const LABEL_DESCRIPTION =
  "Text labels on the layer; omit for none. On a " +
  "simple-feature layer set `attribute` to the column whose " +
  "value labels each feature (points at the point, lines and " +
  "polygons at an interior anchor). On an aggregated hex/grid " +
  "layer omit `attribute` — each cell labels itself with its " +
  "aggregate value, compactly formatted. Heatmaps cannot be " +
  "labeled. Every label an answer carries has a concrete " +
  "`color`, `haloWidth` and `haloColor` beside its two choices: " +
  "for an automatic part, the light-appearance recipe for the " +
  "map's basemap as saved when it is read (a custom style reads " +
  "as light). They are fixed fallbacks for a client that draws a " +
  "label as given, not what any reader saw; saving the style " +
  "stores them, and reading never changes the stored layer.";

const label = (required: string[]) => ({
  type: "object",
  description: LABEL_DESCRIPTION,
  properties: LABEL_PROPERTIES,
  required,
});

const STYLE_DESCRIPTION =
  "A layer's full visual definition. Constant channels plus " +
  "data-driven ones: `strokeBy` drives the outline " +
  "color like `fill` drives the fill; `pointRadiusBy` and " +
  "`strokeWidthBy` drive the sizes. Absent data-driven members " +
  "mean the constant siblings apply.";

const style = (description: string, labelRequired: string[]) => ({
  type: "object",
  additionalProperties: false,
  description,
  properties: {
    fill: { $ref: "#/components/schemas/FillPaint" },
    fillOpacity: {
      type: "number",
      description:
        "0-1 fill translucency; 1 = opaque. Colors are solid — " +
        "the sliders own alpha. Default 1.",
    },
    stroke: {
      type: "object",
      description: "Constant outline color {r, g, b, a}.",
    },
    strokeOpacity: {
      type: "number",
      description: "0-1 multiplier on the stroke alpha. Default 1.",
    },
    strokeWidth: { type: "number" },
    pointRadius: { type: "number" },
    opacity: { type: "number" },
    strokeBy: {
      $ref: "#/components/schemas/FillPaint",
      description:
        "Data-driven outline color; overrides `stroke` when present.",
    },
    pointRadiusBy: {
      $ref: "#/components/schemas/SizeScale",
      description:
        "Data-driven point radius; overrides `pointRadius`.",
    },
    strokeWidthBy: {
      $ref: "#/components/schemas/SizeScale",
      description:
        "Data-driven line/outline width; overrides `strokeWidth`.",
    },
    heightBy: {
      $ref: "#/components/schemas/SizeScale",
      description:
        "Polygon extrusion by attribute: the domain " +
        "maps linearly onto meters (range up to 100000; resolve " +
        "with the scale operation, unit 'm'). Omit for flat.",
    },
    label: label(labelRequired),
  },
});

/** The label members an answer always carries. */
export const ANSWERED_LABEL_REQUIRED = ["size", "textPaint", "color", "haloPaint", "haloWidth", "haloColor"];

export const STYLE_SCHEMAS = {
  Style: style(
    STYLE_DESCRIPTION + " This is the style as an answer carries it; a " +
      "write sends `StyleInput`.",
    ANSWERED_LABEL_REQUIRED,
  ),
  StyleInput: style(
    STYLE_DESCRIPTION + " This is the style as a write sends it: the " +
      "label's paint may be left out, and the text and halo then follow " +
      "the map.",
    ["size"],
  ),
};
