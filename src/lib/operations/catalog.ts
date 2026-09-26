import { ApiError } from "@/lib/api/errors";

/**
 * The operation catalog, served as data.
 *
 * One endpoint runs an operation rather than one endpoint
 * per verb, so the verbs themselves have to be describable — an agent
 * discovers what it may ask for by reading this, and the builder's own picker
 * renders from the same source rather than a second hard-coded list that could
 * drift from it.
 *
 * It begins with one entry on purpose. The nine specs that follow extend a
 * shape rather than inventing one, and an empty catalog would have made
 * "every operation the catalog lists runs" vacuously true.
 */

/**
 * Geometry a verb accepts on an input.
 *
 * `any` includes non-spatial tables; `none` is its opposite and admits **only**
 * a table with no geometry. A verb writing a geometry column onto rows that
 * came without one needs that: a dataset has one active geometry column, so
 * writing a second would either replace a shape the user had or sit beside it
 * as something the registry cannot name.
 */
export type InputGeometry = "any" | "none" | "point" | "line" | "polygon";

/**
 * Something an instance either has or has not.
 *
 * Declared by a verb that cannot run without it, so a picker can say *why* an
 * operation is unavailable instead of offering it and letting the run refuse.
 * The list is deliberately about **deployment configuration**, not about data:
 * what a particular table can be used for is admission's business.
 */
export type Capability = "geocoder" | "isochrone";

/** Whether this instance can run a verb at all, and why not when it cannot.
 * Resolved server-side and served with the catalog — never declared, because it
 * is a fact about the deployment rather than about the verb. */
export interface Availability {
  available: boolean;
  reason: string | null;
}

/**
 * One input a verb takes, and what it is for.
 *
 * A verb with two inputs has two that are **not interchangeable** — a spatial
 * join's left and right mean different things, and the output's geometry comes
 * from one of them. A flat list of accepted geometry classes could not say
 * which, so it could not describe such a verb at all.
 */
export interface OperationInput {
  /** Stable name a caller passes this input under. */
  name: string;
  label: string;
  description: string;
  /** Geometry classes this particular input accepts. */
  accepts: InputGeometry[];
  required: boolean;
}

/** A parameter's shape. `enum` and `field` are why the run path stops
 * flattening parameters to a string: neither survives that. */
export type ParameterType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  /** Several values from a fixed set, as a list. Distinct from `enum`, which
   * is one value: a caller reading `enum` and sending a scalar where a list is
   * expected has been told the wrong shape by the catalog. */
  | "enum_list"
  | "field"
  /** Several columns of one input, as a list of names. Distinct from
   * `field_list`, whose entries are aggregate specifications: a form
   * rendering one as the other sends the wrong shape and the run refuses it. */
  | "column_list"
  | "field_list"
  /** Several plain numbers, as a list — the isochrone's minute bands. The
   * item constraints (`minItems`…`itemsUnique`) are served beside it so a
   * form refuses at the field what admission would refuse on the wire. */
  | "number_list";

export interface OperationParameter {
  name: string;
  type: ParameterType;
  required: boolean;
  /**
   * What makes this parameter required, when it is not always.
   *
   * A distance is needed **only** for a within-distance relationship, and a
   * value **only** for a comparison that compares something. Declared here so
   * a form knows before it submits: a statically optional parameter the server
   * then demands is a form that knowingly sends an invalid request.
   */
  requiredWhen?: { parameter: string; equals: string };
  /** When this parameter is part of the question at all. Absent means
   * always; present, the parameter only applies while the named parameter
   * holds one of these values — a distance is not part of an "intersects"
   * question. Distinct from `requiredWhen`: Filter rows' value is *used*
   * by five comparisons but *required* by one. Additive, served, and the
   * form both hides and omits an inapplicable parameter. */
  relevantWhen?: { parameter: string; oneOf: string[] };
  /** Whether a carried value may be given a name of its own. The spatial
   * join's carry can; a summary's aggregates cannot, and an editor offering
   * the field would produce a column the server silently ignores. */
  aliasable?: boolean;
  description: string;
  /** The permitted values, when the type is an enum. Fixed by the spec, not
   * by whatever an implementation happens to offer. */
  options?: string[];
  /** Which input a field parameter names a column of. */
  ofInput?: string;
  /**
   * The kind of column a `field` parameter may name, when the verb needs one
   * kind.
   *
   * Declared so a form offers the columns that can work rather than every
   * column and a refusal afterwards. Admission checks it too — the picker is
   * not the only caller — but a user should not learn it from a failed run.
   */
  fieldType?: "text" | "number";
  /** Set when the value is a ground measurement, not a bare number. */
  unit?: ParameterUnit;
  /** Bounds for a number parameter, where the verb has hard ones (H3's
   * 0–15). Declared so a form can offer a real slider and refuse before
   * the wire; admission still checks — the picker is not the only
   * caller. */
  min?: number;
  max?: number;
  /** The list constraints of a `number_list`, all served: how many
   * items the list takes, the floor each item must clear, whether items
   * must be whole numbers, and whether duplicates are refused. Admission
   * checks the same rules — the picker is not the only caller. */
  minItems?: number;
  maxItems?: number;
  itemMin?: number;
  itemInteger?: boolean;
  itemsUnique?: boolean;
  default?: string | number | boolean;
}

/**
 * Where a verb's output geometry comes from.
 *
 * Doctrine E7 draws the line: a verb that fixes its class regardless of input —
 * a buffer makes polygons, a centroid makes points — *declares* it, and the dry
 * run skips its probe. A verb that passes geometry through cannot declare
 * anything, and its result has to be inspected. Saying so here is what lets a
 * caller know which answer it will get before it asks.
 */
export type OutputGeometry =
  /** Whatever the result turns out to hold, including none — discovered by
   * inspecting it. The SQL step and the plain data verbs are this. */
  | { kind: "probed" }
  /** Never any geometry, whatever the inputs held. */
  | { kind: "none" }
  /** Passed through from a named input. */
  | { kind: "from_input"; input: string }
  /** Fixed by the verb regardless of its inputs. */
  | { kind: "fixed"; geometry: Exclude<InputGeometry, "any"> };

export interface OperationDef {
  id: string;
  /** The group a picker files it under. */
  group: string;
  label: string;
  /**
   * The glyph a picker draws beside the label, named from the app's shared
   * icon set. Presentation metadata served as data for the same reason the
   * catalog itself is: one home, and a verb cannot drift.
   */
  symbol: string;
  /**
   * One plain-text line for pickers and the form header — under 90
   * characters, no markdown. `description` stays the reference text the
   * docs page renders; this is the working surface's sentence.
   */
  blurb: string;
  description: string;
  /**
   * The inputs this verb takes, in order, each with its role.
   *
   * A verb that generates its own SQL from named inputs declares them here. The
   * SQL step declares none — its single input is whatever its query names — and
   * that difference is itself information a caller needs.
   */
  inputs: OperationInput[];
  /** Input geometry classes the verb accepts overall. Kept for the verbs that
   * take a single unnamed input, and for a picker filtering a flat list. */
  accepts: InputGeometry[];
  parameters: OperationParameter[];
  /** Where the result's geometry comes from. */
  outputGeometry: OutputGeometry;
  /** What this instance must be configured with for the verb to run at all. */
  requires?: Capability[];
  /**
   * Filled in when the catalog is served, never written here.
   *
   * A verb that declares no requirement is always available and carries none of
   * this; a reader treats its absence as available, so nothing has to know
   * which verbs have requirements.
   */
  availability?: Availability;
}

/**
 * A parameter whose value is a **ground measurement**.
 *
 * Declared so an agent knows which numbers mean metres on the earth without
 * knowing the verb in advance — and so the next verb that takes one cannot
 * quietly present it as a bare number.
 */
/** `metres` is a ground measurement; `minutes` is travel time —
 * declared so a form labels the field and no caller guesses the unit. */
export type ParameterUnit = "metres" | "minutes";

/** One sentence, written once: every verb's output name means the same thing
 * and refuses on the same terms. */
/**
 * The ceiling every ground-metres parameter serves: half the WGS84
 * meridional circumference, rounded up to a whole metre. The longest
 * shortest-path between two points on the ground runs pole over pole, so no
 * value above this is a distance — it is a typo wearing a unit.
 */
export const GROUND_METRES_MAX = 20_003_932;

const OUTPUT_NAME =
  "Name for the new dataset. An existing name is refused rather than " +
  "replaced or renamed around.";

export const OPERATIONS: OperationDef[] = [
  {
    id: "sql_step",
    group: "Data",
    label: "SQL step",
    symbol: "code",
    blurb: "Keep the result of a query as a durable dataset",
    description:
      "Keep the result of a read-only SELECT as a durable dataset. The " +
      "escape hatch inside any recipe, and the way to save a query you " +
      "already trust — including one that returns no geometry.",
    // The SQL step's input is whatever its query names, so it declares none —
    // and a caller can tell that apart from "takes no input at all".
    inputs: [],
    accepts: ["any"],
    // Whatever the query returns — which may be nothing, and is the case that
    // gave its "a result with no geometry is a dataset, not a failure".
    outputGeometry: { kind: "probed" },
    parameters: [
      {
        name: "sql",
        type: "string",
        required: true,
        description: "The read-only SELECT whose result becomes the dataset.",
      },
      {
        name: "name",
        type: "string",
        required: true,
        description:
          "Name for the new dataset. An existing name is refused rather " +
          "than replaced or renamed around.",
      },
    ],
  },
  {
    id: "spatial_join",
    group: "Overlay",
    label: "Spatial join",
    symbol: "overlay",
    blurb: "Summarise one table into the shapes of another",
    description:
      "Enrich one dataset with values from another wherever they meet in " +
      "space. The result has one row per feature of the left input — never " +
      "more — carrying values aggregated from the right features that " +
      "satisfy the relationship. A left feature that matches nothing is " +
      "kept, with a match count of zero.",
    inputs: [
      {
        name: "left",
        label: "Features to enrich",
        description:
          "One row per feature of this input comes out, and the result's " +
          "geometry is this input's.",
        // Not `any`: `any` explicitly includes non-spatial tables, and a join
        // refuses one. Advertising `any` here would tell an agent a
        // geometryless table is a legal input and let it find out at admission.
        accepts: ["point", "line", "polygon"],
        required: true,
      },
      {
        name: "right",
        label: "Features to take values from",
        description:
          "Values are carried across from the features of this input that " +
          "satisfy the relationship. Its geometry is not kept.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "from_input", input: "left" },
    parameters: [
      {
        name: "predicate",
        type: "enum",
        required: true,
        description:
          "How the two must be related, read left-relative-to-right: " +
          "\"within\" means each left feature inside a right one.",
        options: [
          "intersects",
          "contains",
          "within",
          "touches",
          "crosses",
          "overlaps",
        ],
        default: "intersects",
      },
      {
        name: "carry",
        type: "field_list",
        required: true,
        options: ["count", "sum", "mean", "min", "max", "any"],
        aliasable: true,
        description:
          "The values to bring across, each an aggregate over the matched " +
          "right features: count, sum, mean, min, max or any value. Numeric " +
          "aggregates are refused on non-numeric columns rather than " +
          "answering nothing.",
        ofInput: "right",
      },
      {
        name: "name",
        type: "string",
        required: true,
        description:
          "Name for the new dataset. An existing name is refused rather " +
          "than replaced or renamed around.",
      },
    ],
  },
  {
    id: "buffer",
    group: "Proximity",
    label: "Buffer",
    symbol: "buffer",
    blurb: "A ring at a set distance around every feature",
    description:
      "Grow each feature into the area within a given distance of it. The " +
      "distance is **ground metres** — five hundred metres from the feature " +
      "on the earth, at the latitude it actually occupies — measured in a " +
      "projection resolved from the data's own extent. Data spanning more of " +
      "the earth than any local projection covers is refused rather than " +
      "measured wrongly.",
    inputs: [
      {
        name: "input",
        label: "Features to buffer",
        description: "One ring comes out per feature of this input.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "fixed", geometry: "polygon" },
    parameters: [
      {
        name: "distance",
        type: "number",
        required: true,
        unit: "metres",
        max: GROUND_METRES_MAX,
        description:
          "How far the ring stands from each feature, in metres on the " +
          "ground. Not degrees, and not metres on a map projection. Must be " +
          "greater than zero: a buffer of nothing is the input, and a " +
          "negative one is a different operation.",
      },
      {
        name: "name",
        type: "string",
        required: true,
        description:
          "Name for the new dataset. An existing name is refused rather " +
          "than replaced or renamed around.",
      },
    ],
  },
  {
    id: "measure_columns",
    group: "Geometry",
    label: "Measure columns",
    symbol: "ruler",
    blurb: "Add area, length, x or y as real columns",
    description:
      "Add a column per measurement, keeping every column the input already " +
      "has. **Area** is in square metres and **length** in metres, both on " +
      "the ground; **x** and **y** are the stored longitude and latitude of " +
      "each feature's centre, which are coordinates rather than " +
      "measurements. Area and length take different halves of the projection " +
      "strategy, so a dataset too wide for a local projection can still be " +
      "measured for area and is refused for length.",
    inputs: [
      {
        name: "input",
        label: "Features to measure",
        description: "The dataset whose features are measured.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    // Its own geometry, unchanged — the operation adds columns beside it.
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [
      {
        name: "measures",
        type: "enum_list",
        required: true,
        options: ["area", "length", "x", "y"],
        description:
          "Which measurements to add — one or more, as a list. area → " +
          "area_m2, square metres of ground; length → length_m, metres of " +
          "ground, which for a polygon is its perimeter; x and y → the " +
          "stored longitude and latitude of the feature's centre, which are " +
          "coordinates rather than measurements. A column the input already " +
          "has under one of those names is refused rather than shadowed.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  // ---- Proximity ---------------------------------------------------------
  {
    id: "nearest_join",
    group: "Proximity",
    label: "Nearest join",
    symbol: "nearest",
    blurb: "Attach the closest feature from another table",
    description:
      "For each feature of the left input, find the **nearest** feature of " +
      "the right and carry values from it, with the distance in ground " +
      "metres. One row out per left feature, always: a feature with nothing " +
      "near it is kept, with the carried values and the distance empty. An " +
      "optional maximum distance bounds the search.",
    inputs: [
      {
        name: "left",
        label: "Features to enrich",
        description: "One row per feature of this input comes out.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
      {
        name: "right",
        label: "Features to find",
        description: "The nearest of these is found for each left feature.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "from_input", input: "left" },
    parameters: [
      {
        name: "carry",
        type: "column_list",
        required: false,
        description:
          "Columns of the right input to bring across from the nearest " +
          "feature.",
        ofInput: "right",
      },
      {
        name: "max_distance",
        type: "number",
        required: false,
        unit: "metres",
        max: GROUND_METRES_MAX,
        description:
          "Search no further than this, in metres on the ground. Left empty, " +
          "the nearest feature is found however far away it is.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "filter_by_location",
    group: "Proximity",
    label: "Filter by location",
    // The field ruling: its own symbol; plain filter stays
    // with Filter rows.
    symbol: "filter_location",
    blurb: "Keep only features that pass a spatial test",
    description:
      "Keep the features that stand in a named relationship to **any** " +
      "feature of another input — intersecting it, inside it, containing it, " +
      "within a distance of it, or disjoint from it. A feature near three " +
      "others is kept once, not three times.",
    inputs: [
      {
        name: "input",
        label: "Features to filter",
        description: "The features that are kept or dropped.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
      {
        name: "mask",
        label: "Features to test against",
        description: "The relationship is tested against these; none is kept.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [
      {
        name: "relation",
        type: "enum",
        required: true,
        options: ["intersects", "within", "contains", "within_distance"],
        default: "intersects",
        description:
          "How a kept feature must relate to the mask, read input-relative-" +
          "to-mask. \"within_distance\" needs a distance.",
      },
      {
        name: "negate",
        type: "boolean",
        required: false,
        default: false,
        description:
          "Keep the features that do **not** stand in that relationship. " +
          "Every relationship can be negated: not-within is not the same " +
          "question as disjoint, since a point on a boundary is neither " +
          "within the polygon nor disjoint from it.",
      },
      {
        name: "distance",
        type: "number",
        required: false,
        requiredWhen: { parameter: "relation", equals: "within_distance" },
        relevantWhen: { parameter: "relation", oneOf: ["within_distance"] },
        unit: "metres",
        max: GROUND_METRES_MAX,
        description:
          "How near counts, in metres on the ground. Only for the " +
          "\"within_distance\" relationship.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  // ---- Overlay -----------------------------------------------------------
  {
    id: "clip",
    group: "Overlay",
    label: "Intersect / clip",
    symbol: "clip",
    blurb: "Cut features down to an overlapping shape",
    description:
      "Cut the input to the shape of the clip layer. One row out per input " +
      "feature that survives, carrying its own values; a feature clipped to " +
      "nothing is dropped rather than kept as an empty shape. The clip is " +
      "the **whole** of the second input, so a feature crossing three of its " +
      "features comes back once, not three times.",
    inputs: [
      {
        name: "input",
        label: "Features to cut",
        description: "One row per surviving feature of this input.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
      {
        name: "clip",
        label: "Shape to cut to",
        description: "Everything outside these shapes is removed.",
        accepts: ["polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [{ name: "name", type: "string", required: true, description: OUTPUT_NAME }],
  },
  {
    id: "difference",
    group: "Overlay",
    label: "Difference",
    symbol: "difference",
    blurb: "Subtract one table’s shapes from another’s",
    description:
      "Keep the parts of the input that fall **outside** the eraser. One row " +
      "out per input feature with something left of it; a feature erased " +
      "entirely is dropped.",
    inputs: [
      {
        name: "input",
        label: "Features to erase from",
        description: "One row per surviving feature of this input.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
      {
        name: "erase",
        label: "Shape to erase",
        description: "Everything inside these shapes is removed.",
        accepts: ["polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [{ name: "name", type: "string", required: true, description: OUTPUT_NAME }],
  },
  {
    id: "union",
    group: "Overlay",
    label: "Union",
    symbol: "union",
    blurb: "Merge two tables into one geometry set",
    description:
      "The overlay union of two inputs: the part they share, and the part " +
      "each holds alone. **Every piece says which input it came from** in a " +
      "`source` column reading both, left or right. Attributes are not " +
      "carried — a union of two tables with columns of the same name has no " +
      "honest answer for which one wins.",
    inputs: [
      {
        name: "left",
        label: "First input",
        description: "Its area alone comes back as `left`.",
        accepts: ["polygon"],
        required: true,
      },
      {
        name: "right",
        label: "Second input",
        description: "Its area alone comes back as `right`.",
        accepts: ["polygon"],
        required: true,
      },
    ],
    accepts: ["polygon"],
    outputGeometry: { kind: "fixed", geometry: "polygon" },
    parameters: [{ name: "name", type: "string", required: true, description: OUTPUT_NAME }],
  },
  // ---- Aggregation -------------------------------------------------------
  {
    id: "dissolve",
    group: "Aggregation",
    label: "Dissolve",
    symbol: "dissolve",
    blurb: "Merge touching shapes, optionally per group",
    description:
      "Merge features into one shape per group, or one shape overall. The " +
      "count of features merged is carried, because one row from one feature " +
      "and one row from four hundred look identical otherwise.",
    inputs: [
      {
        name: "input",
        label: "Features to merge",
        description: "The features that are dissolved together.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [
      {
        name: "group_by",
        type: "column_list",
        required: false,
        ofInput: "input",
        description:
          "Merge features sharing these values. Left empty, everything " +
          "becomes one shape.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "group_summarize",
    group: "Aggregation",
    label: "Group & summarize",
    // The field ruling: its own symbol; stats stays with the
    // Statistics verb, Hotspot analysis.
    symbol: "summarize",
    blurb: "Count, sum or average rows per group",
    description:
      "One row per group, with the aggregates asked for. **The result has no " +
      "geometry** — it is a table you can join against, which is a dataset " +
      "rather than a failure. Each aggregate is named for what it is, so a " +
      "column called `sum_population` still says something a month later.",
    inputs: [
      {
        name: "input",
        label: "Features to summarize",
        description: "The rows that are grouped.",
        accepts: ["any"],
        required: true,
      },
    ],
    accepts: ["any"],
    outputGeometry: { kind: "none" },
    parameters: [
      {
        name: "group_by",
        type: "column_list",
        required: false,
        ofInput: "input",
        description:
          "Group rows sharing these values. Left empty, the whole table is " +
          "one group.",
      },
      {
        name: "aggregates",
        type: "field_list",
        required: true,
        ofInput: "input",
        // The set this verb accepts, which is not the spatial join's: there is
        // no `any` here, and a carried value takes no name of its own.
        options: ["count", "sum", "mean", "min", "max"],
        aliasable: false,
        description:
          "What to compute per group — count, sum, mean, min or max, each " +
          "with the column it works on except count.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  // ---- Geometry ----------------------------------------------------------
  {
    id: "centroid",
    group: "Geometry",
    label: "Centroid",
    symbol: "centroid",
    blurb: "Replace shapes with their centre point",
    description:
      "One point per feature, at the feature's centre of mass. **It is the " +
      "centroid, not a point guaranteed to be inside the shape**: for a " +
      "horseshoe or a ring the centre of mass falls outside the feature " +
      "itself, and substituting a different point would be a different " +
      "measurement under the same name.",
    inputs: [
      {
        name: "input",
        label: "Features to reduce",
        description: "One point comes out per feature of this input.",
        accepts: ["line", "polygon", "point"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    outputGeometry: { kind: "fixed", geometry: "point" },
    parameters: [{ name: "name", type: "string", required: true, description: OUTPUT_NAME }],
  },
  {
    id: "convex_hull",
    group: "Geometry",
    label: "Convex hull",
    symbol: "hull",
    blurb: "The tightest containing shape around features",
    description:
      "The smallest convex shape containing the features — one per group, or " +
      "one overall. The count of features inside it is carried, because a " +
      "hull over a single point is that point.",
    inputs: [
      {
        name: "input",
        label: "Features to wrap",
        description: "The features the hull is drawn around.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    // **Probed, not fixed.** A hull of one point is a point and a hull of two
    // collinear points is a line — the description says so, and declaring
    // polygon would tell an agent something the run contradicts.
    outputGeometry: { kind: "probed" },
    parameters: [
      {
        name: "group_by",
        type: "column_list",
        required: false,
        ofInput: "input",
        description:
          "One hull per group. Left empty, one hull over everything.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "simplify",
    group: "Geometry",
    label: "Simplify",
    symbol: "simplify",
    blurb: "Drop vertices within a tolerance",
    description:
      "Fewer vertices, within a tolerance in **ground metres**. " +
      "**Topology is not preserved**: each feature is simplified on its own, " +
      "so two polygons that shared a border can come out with a gap or an " +
      "overlap between them. A feature smaller than the tolerance can " +
      "simplify to nothing — it is dropped from the result, not kept as an " +
      "empty shape.",
    inputs: [
      {
        name: "input",
        label: "Features to simplify",
        description: "The features whose outlines are reduced.",
        accepts: ["line", "polygon"],
        required: true,
      },
    ],
    accepts: ["line", "polygon"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [
      {
        name: "tolerance",
        type: "number",
        required: true,
        unit: "metres",
        max: GROUND_METRES_MAX,
        description:
          "How far a simplified outline may stand from the original, in " +
          "metres on the ground. Larger means fewer vertices and a coarser " +
          "shape.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  // ---- Data --------------------------------------------------------------
  {
    id: "filter_rows",
    group: "Data",
    label: "Filter rows",
    symbol: "filter",
    blurb: "Keep rows matching a condition",
    description:
      "Keep the rows matching one condition on a column. One condition rather " +
      "than a builder: a layer's own filters already compose several, and a " +
      "step that needs more than one is a SQL step.",
    inputs: [
      {
        name: "input",
        label: "Rows to filter",
        description: "The dataset whose rows are kept or dropped.",
        accepts: ["any"],
        required: true,
      },
    ],
    accepts: ["any"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [
      {
        name: "field",
        type: "field",
        required: true,
        ofInput: "input",
        description: "The column the condition reads.",
      },
      {
        name: "comparison",
        type: "enum",
        required: true,
        options: [
          "equals",
          "not_equals",
          "greater_than",
          "less_than",
          "contains",
          "is_null",
          "is_not_null",
        ],
        default: "equals",
        description: "How the column is compared against the value.",
      },
      {
        name: "value",
        type: "string",
        required: false,
        requiredWhen: { parameter: "comparison", equals: "equals" },
        relevantWhen: {
          parameter: "comparison",
          oneOf: ["equals", "not_equals", "greater_than", "less_than", "contains"],
        },
        description:
          "What to compare against. Not needed for \"is null\" and \"is not " +
          "null\".",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "join_by_key",
    group: "Data",
    label: "Join by key",
    symbol: "key",
    blurb: "Match rows on a shared column",
    description:
      "Carry values across from another dataset by matching a column, not by " +
      "geometry. One row out per left row — where the key matches several " +
      "rows on the right, the first is taken and the match count is carried, " +
      "so a key that was not unique is visible rather than silent.",
    inputs: [
      {
        name: "left",
        label: "Rows to enrich",
        description: "One row per row of this input comes out.",
        accepts: ["any"],
        required: true,
      },
      {
        name: "right",
        label: "Rows to take values from",
        description: "Values are carried across from these.",
        accepts: ["any"],
        required: true,
      },
    ],
    accepts: ["any"],
    outputGeometry: { kind: "from_input", input: "left" },
    parameters: [
      {
        name: "left_key",
        type: "field",
        required: true,
        ofInput: "left",
        description: "The column on the left that is matched.",
      },
      {
        name: "right_key",
        type: "field",
        required: true,
        ofInput: "right",
        description: "The column on the right that is matched against it.",
      },
      {
        name: "carry",
        type: "column_list",
        required: false,
        ofInput: "right",
        description: "Columns of the right input to bring across.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "h3_cell",
    group: "Statistics",
    label: "Assign H3 cells",
    symbol: "hex",
    blurb: "Tag each feature with its H3 cell",
    description:
      "Add the **H3 cell** each feature falls in, at a chosen resolution, " +
      "beside everything the input already has. One row in, one row out: a " +
      "feature with no geometry keeps its place with no cell rather than a " +
      "wrong one. Optionally the output is redrawn as the cells themselves.",
    inputs: [
      {
        name: "input",
        label: "Features to assign",
        description:
          "A point is its own representative; a line or polygon uses its " +
          "centroid, which for a concave shape can lie outside the shape.",
        accepts: ["point", "line", "polygon"],
        required: true,
      },
    ],
    accepts: ["point", "line", "polygon"],
    // The class depends on a parameter rather than on the verb, so it cannot
    // be declared (doctrine E7): pass-through by default, cells when redrawn.
    outputGeometry: { kind: "probed" },
    parameters: [
      {
        name: "resolution",
        type: "number",
        required: true,
        default: 8,
        min: 0,
        max: 15,
        description:
          "H3 resolution, 0 (continent-sized) to 15 (about a square metre). " +
          "8 is roughly a neighbourhood.",
      },
      {
        name: "boundary",
        type: "boolean",
        required: false,
        default: false,
        description:
          "Replace the geometry with the cell's own boundary, so the result " +
          "draws as cells. Off by default: assigning a cell answers a column, " +
          "not a redrawn map.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "hotspot",
    group: "Statistics",
    label: "Hotspot analysis (Getis-Ord Gi*)",
    symbol: "stats",
    blurb: "Find statistically hot and cold clusters",
    description:
      "Aggregate points into **H3 cells** and score each cell against its " +
      "neighbourhood, answering one row per cell with its value, its Gi* " +
      "z-score, the number of neighbours the score was computed over, and " +
      "the cell boundary. The score is a z-score, not a verdict: where a " +
      "reader wants *is this significant*, the threshold is theirs.",
    inputs: [
      {
        name: "input",
        label: "Points to score",
        description: "Points are aggregated into cells and scored.",
        accepts: ["point"],
        required: true,
      },
    ],
    accepts: ["point"],
    outputGeometry: { kind: "fixed", geometry: "polygon" },
    parameters: [
      {
        name: "resolution",
        type: "number",
        required: true,
        default: 8,
        min: 0,
        max: 15,
        description:
          "H3 resolution, 0 to 15. Coarser cells hold more points and give " +
          "smoother scores.",
      },
      {
        name: "value",
        type: "enum",
        required: false,
        default: "count",
        options: ["count", "sum"],
        description:
          "What a cell is worth: how many points landed in it, or the sum of " +
          "one of their numeric columns.",
      },
      {
        name: "field",
        type: "field",
        required: false,
        ofInput: "input",
        requiredWhen: { parameter: "value", equals: "sum" },
        relevantWhen: { parameter: "value", oneOf: ["sum"] },
        description:
          "The numeric column to sum. A cell where every value is empty is " +
          "not scored at all, rather than counted as a zero nobody observed.",
      },
      {
        name: "neighbours",
        type: "number",
        required: false,
        default: 1,
        min: 1,
        max: 10,
        description:
          "How many H3 steps out the neighbourhood reaches, 1 to 10. The " +
          "cell is always inside its own neighbourhood.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "cluster_by_distance",
    group: "Statistics",
    label: "Cluster points by distance",
    symbol: "points",
    blurb: "Group points that fall near each other",
    description:
      "Group points **within a distance of each other**, following chains: A " +
      "near B and B near C puts all three together even where A and C are " +
      "far apart. Every row keeps its place and gains a cluster and that " +
      "cluster's size; a point near nothing is its own cluster of one. This " +
      "is single-link clustering — **it is not DBSCAN**: there is no " +
      "minimum-points rule and no noise class.",
    inputs: [
      {
        name: "input",
        label: "Points to cluster",
        description:
          "Up to 10,000 rows. Above that the run is refused rather than " +
          "started, because following chains through more is a query that " +
          "does not come back.",
        accepts: ["point"],
        required: true,
      },
    ],
    accepts: ["point"],
    outputGeometry: { kind: "from_input", input: "input" },
    parameters: [
      {
        name: "distance",
        type: "number",
        required: true,
        unit: "metres",
        max: GROUND_METRES_MAX,
        description:
          "How close two points must be to join the same cluster, in metres " +
          "on the ground. Exactly this far apart counts as within.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "geocode_addresses",
    group: "Data",
    label: "Geocode addresses",
    symbol: "pin",
    blurb: "Turn a column of addresses into points",
    description:
      "Turn a column of addresses into points, by asking this instance's " +
      "configured geocoding provider. Every row comes back — the original " +
      "columns untouched, plus the point and a column saying plainly what " +
      "happened to the rows that did not resolve. Answers are cached, so " +
      "running it again after a failure only costs the addresses it still " +
      "lacks.",
    inputs: [
      {
        name: "input",
        label: "Table of addresses",
        description:
          "A table with no geometry of its own — a spreadsheet of addresses " +
          "is the ordinary case. A table that already carries geometry is " +
          "refused rather than having its shapes replaced.",
        accepts: ["none"],
        required: true,
      },
    ],
    accepts: ["none"],
    // Points, whatever the input held — which is nothing, by the input's own
    // declaration. A row that did not resolve has no point, not a different one.
    outputGeometry: { kind: "fixed", geometry: "point" },
    requires: ["geocoder"],
    parameters: [
      {
        name: "column",
        type: "field",
        ofInput: "input",
        fieldType: "text",
        required: true,
        description:
          "The column holding the address to look up. One request per " +
          "distinct address, so a repeated address costs nothing extra.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
  {
    id: "isochrone",
    group: "Data",
    label: "Isochrone / travel-time area",
    symbol: "clock",
    blurb: "Reachable area within a travel time",
    description:
      "Ask this instance's configured routing provider how far you can " +
      "travel from each point within one or more time bands, and keep the " +
      "reachable areas as polygons — **one row per origin per band**, " +
      "answered or not, so an unreachable origin is visible rather than " +
      "absent. Bands are minutes; no departure time is sent, so the same " +
      "question gives the same answer tomorrow. Answers are cached; " +
      "re-running after a failure only costs the origins still unanswered.",
    inputs: [
      {
        name: "input",
        label: "Origins",
        description:
          "A table of points travel is asked from. Each point's own " +
          "columns survive into every one of its rows.",
        accepts: ["point"],
        required: true,
      },
    ],
    accepts: ["point"],
    // The reachable area replaces the origin's point — every input geometry
    // column is excluded and the polygon is the output's only one (K3).
    outputGeometry: { kind: "fixed", geometry: "polygon" },
    requires: ["isochrone"],
    parameters: [
      {
        name: "travel_mode",
        type: "enum",
        required: true,
        options: ["driving", "walking", "cycling"],
        default: "driving",
        description:
          "How travel happens. This product's words, mapped to the " +
          "provider's own profiles at the boundary (K5).",
      },
      {
        name: "bands",
        type: "number_list",
        required: true,
        unit: "minutes",
        minItems: 1,
        maxItems: 4,
        itemMin: 1,
        itemInteger: true,
        itemsUnique: true,
        description:
          "The travel-time bands, in whole minutes — one reachable area " +
          "per band, per origin. Up to four, each asked once.",
      },
      { name: "name", type: "string", required: true, description: OUTPUT_NAME },
    ],
  },
];


export function findOperation(id: string): OperationDef {
  const found = OPERATIONS.find((o) => o.id === id);
  if (!found) {
    throw new ApiError(
      "invalid_request",
      `Unknown operation "${id}". Read the operation catalog for the ` +
        `operations this instance offers.`,
      400,
    );
  }
  return found;
}
