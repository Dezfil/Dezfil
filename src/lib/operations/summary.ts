import { findOperation, type OperationDef } from "./catalog";

/**
 * The one-line sentence a step row reads.
 *
 * **It is the API's, not the drawer's**, and that is an obligation rather than
 * a convenience. The phase's amendment A1 replaced prototype 05's plain-
 * sentence parameter form with a labelled grid, and named this as the
 * compensation: the row carries a summary the API, the drawer and any agent
 * read identically. Two surfaces composing their own would drift, and the
 * drift would be invisible — each would look right on its own.
 *
 * **It describes what the step means now.** A step carrying a proposal means
 * what its output was produced from until that proposal runs (` `), so this
 * reads the active parameters and says so by saying nothing about the proposal
 * — the row shows the pending edit separately, where it can be labelled as
 * pending.
 */

/** A value as the sentence says it: a metre count keeps its unit, a list
 * becomes a phrase, and a long query becomes its shape rather than its text. */
function say(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    const parts = value.map((entry) => {
      if (typeof entry === "object" && entry !== null) {
        const { aggregate, field } = entry as Record<string, unknown>;
        if (typeof aggregate === "string") {
          return typeof field === "string" ? `${aggregate} of ${field}` : aggregate;
        }
        return JSON.stringify(entry);
      }
      return String(entry);
    });
    const listed =
      parts.length <= 3
        ? parts.join(", ")
        : `${parts.slice(0, 3).join(", ")} and ${parts.length - 3} more`;
    // A unit-bearing list keeps its unit: "5, 10 min", not bare numbers
    // a reader has to guess the dimension of.
    if (unit === "minutes") return `${listed} min`;
    if (unit === "metres") return `${listed} m`;
    return listed;
  }
  if (typeof value === "number" && unit === "metres") return `${value} m`;
  if (typeof value === "number" && unit === "minutes") return `${value} min`;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text;
}

/**
 * Compose the sentence.
 *
 * **Composed from the catalog rather than from a table of verbs**, so a verb
 * a later spec adds gets a sentence without this module changing — the same
 * property that makes the picker render from data. Where a verb reads better
 * with words of its own it says so below, and every verb, named or not, still
 * names its inputs and its parameters.
 */
export function parameterSummary(
  operation: OperationDef,
  parameters: Record<string, unknown>,
): string {
  const inputs = operation.inputs
    .map((input) => parameters[input.name])
    .filter((value): value is string => typeof value === "string" && value !== "");

  const named = operation.parameters
    .filter((parameter) => parameter.name !== "name")
    .map((parameter) => {
      const value = parameters[parameter.name];
      if (value === undefined || value === "" ) return null;
      if (Array.isArray(value) && value.length === 0) return null;
      return { parameter, said: say(value, parameter.unit) };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  switch (operation.id) {
    case "buffer": {
      const distance = named.find((n) => n.parameter.name === "distance");
      return distance
        ? `${distance.said} around ${inputs[0] ?? "an input"}`
        : `around ${inputs[0] ?? "an input"}`;
    }
    case "spatial_join": {
      const predicate = named.find((n) => n.parameter.name === "predicate");
      const carry = named.find((n) => n.parameter.name === "carry");
      const relation = predicate ? predicate.said : "intersects";
      const left = inputs[0] ?? "an input";
      const right = inputs[1] ?? "another input";
      return carry
        ? `${left} ${relation} ${right}, carrying ${carry.said}`
        : `${left} ${relation} ${right}`;
    }
    case "measure_columns": {
      const measures = named.find((n) => n.parameter.name === "measures");
      return measures
        ? `${measures.said} of ${inputs[0] ?? "an input"}`
        : `measurements of ${inputs[0] ?? "an input"}`;
    }
    case "clip": {
      return `${inputs[0] ?? "an input"} cut to ${inputs[1] ?? "a shape"}`;
    }
    case "difference": {
      return `${inputs[0] ?? "an input"} outside ${inputs[1] ?? "a shape"}`;
    }
    case "union": {
      return `${inputs[0] ?? "an input"} and ${inputs[1] ?? "another"}, overlaid`;
    }
    case "centroid": {
      return `the centre of each of ${inputs[0] ?? "an input"}`;
    }
    case "convex_hull": {
      const groups = named.find((n) => n.parameter.name === "group_by");
      return groups
        ? `a hull per ${groups.said} of ${inputs[0] ?? "an input"}`
        : `a hull around ${inputs[0] ?? "an input"}`;
    }
    case "dissolve": {
      const groups = named.find((n) => n.parameter.name === "group_by");
      return groups
        ? `${inputs[0] ?? "an input"} merged per ${groups.said}`
        : `${inputs[0] ?? "an input"} merged into one shape`;
    }
    case "group_summarize": {
      const groups = named.find((n) => n.parameter.name === "group_by");
      const aggregates = named.find((n) => n.parameter.name === "aggregates");
      const per = groups ? ` per ${groups.said}` : "";
      return `${aggregates ? aggregates.said : "a summary"} of ${
        inputs[0] ?? "an input"
      }${per}`;
    }
    case "simplify": {
      const tolerance = named.find((n) => n.parameter.name === "tolerance");
      return `${inputs[0] ?? "an input"} simplified${
        tolerance ? ` to ${tolerance.said}` : ""
      }`;
    }
    case "filter_rows": {
      const field = named.find((n) => n.parameter.name === "field");
      const comparison = named.find((n) => n.parameter.name === "comparison");
      const value = named.find((n) => n.parameter.name === "value");
      const test = [
        field?.said,
        comparison?.said.replace(/_/g, " "),
        value?.said,
      ]
        .filter(Boolean)
        .join(" ");
      return `${inputs[0] ?? "an input"} where ${test || "a condition holds"}`;
    }
    case "join_by_key": {
      const leftKey = named.find((n) => n.parameter.name === "left_key");
      const rightKey = named.find((n) => n.parameter.name === "right_key");
      return `${inputs[0] ?? "an input"} joined to ${
        inputs[1] ?? "another"
      } on ${leftKey?.said ?? "a key"} = ${rightKey?.said ?? "a key"}`;
    }
    case "nearest_join": {
      const max = named.find((n) => n.parameter.name === "max_distance");
      return `${inputs[0] ?? "an input"} → nearest ${inputs[1] ?? "feature"}${
        max ? ` within ${max.said}` : ""
      }`;
    }
    case "filter_by_location": {
      const relation = named.find((n) => n.parameter.name === "relation");
      const distance = named.find((n) => n.parameter.name === "distance");
      const said = (relation?.said ?? "intersects").replace(/_/g, " ");
      return `${inputs[0] ?? "an input"} ${said}${
        distance ? ` ${distance.said} of` : ""
      } ${inputs[1] ?? "a mask"}`;
    }
    case "sql_step": {
      const sql = parameters.sql;
      if (typeof sql !== "string" || sql.trim() === "") return "a query";
      const flat = sql.replace(/\s+/g, " ").trim();
      return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
    }
    default: {
      // The generic shape, which every verb can produce: what it reads, then
      // what it was asked for. A verb that reads better with words of its own
      // adds a case above rather than leaving this to be wrong quietly.
      const reads = inputs.length > 0 ? inputs.join(" and ") : "";
      const asked = named
        .map((n) => `${n.parameter.name.replace(/_/g, " ")} ${n.said}`)
        .join(", ");
      if (reads && asked) return `${reads} · ${asked}`;
      // `||`, not `??`: an empty join is a string, and falling through on
      // nullish alone returned it — a row with no sentence at all, which the
      // sweep caught the moment twelve verbs arrived.
      return reads || asked || operation.label.toLowerCase();
    }
  }
}

/** The sentence for a step as the API answers it. */
export function summaryFor(
  operationId: string,
  parameters: Record<string, unknown>,
): string {
  return parameterSummary(findOperation(operationId), parameters);
}
