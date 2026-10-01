/**
 * The context SQL or a dataset name was written in, as operations that take
 * text accept it: evaluated there, or carried from there into the context
 * that stores it with every dataset reference keeping its meaning.
 */

/** How a carried reference is written again, and when a handoff refuses. */
export const CARRY_RULE =
  "Each dataset reference keeps the dataset it meant where it was written: " +
  "a plain name of a dataset the destination's SQL home does not own, or " +
  "whose name an output there takes, becomes <sql name>.<dataset>; an " +
  "already qualified name stays as written; a workflow's own output becomes " +
  "the dataset the caller's latest successful run of it made. Only those " +
  "references change; the rest of the text is kept as written, and nothing " +
  "where it came from is touched. A reference that cannot be carried (a " +
  "dataset outside the caller's reach, an output the caller has not " +
  "produced, a computed table name that would have to change) refuses the " +
  "request with sql_error naming it, and nothing is written.";

export const WRITTEN_IN_SCHEMAS = {
  WrittenIn: {
    type: "object",
    description:
      "Where SQL or a dataset name was written: the context whose names it " +
      "uses. console is the caller's own SQL console, where a plain name is " +
      "the caller's own dataset; map is a map's SQL home, as its layers are " +
      "read; workflow is a workflow's home with its declared outputs as the " +
      "caller runs them. A map or workflow the caller does not reach answers " +
      "as a missing one.",
    properties: {
      kind: { type: "string", enum: ["console", "map", "workflow"] },
      id: { type: "string", description: "The map or workflow; absent for console." },
    },
    required: ["kind"],
    additionalProperties: false,
  },
};

export const WRITTEN_IN_REF = { $ref: "#/components/schemas/WrittenIn" };
