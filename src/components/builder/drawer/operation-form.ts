import { deriveTableName } from "@/lib/ingest/naming";
import type { OperationDef, OperationParameter } from "@/lib/operations/catalog";
import { suitsFieldType } from "@/lib/operations/column-types";
import type { TableListing } from "../../api";

/**
 * The parameter form's own arithmetic.
 *
 * The Result section is the flagship moment — the last thing a user reads
 * before pressing Run — and three of its facts are decided here rather than in
 * the component, because each of them can be wrong in a way a rendering test
 * would not notice: what name the result will *actually* carry, whether that
 * name is free, and whether this operation's result can be a layer at all.
 */

/**
 * The name the registry will use, which is not always the name that was typed.
 *
 * The materializer sanitizes into a SQL identifier — "Bus Stops" registers as
 * `bus_stops` — so a form that promised the typed string would deliver
 * something else, which is the defect G2 exists to prevent. The sanitizer is
 * **imported rather than mirrored**: a copy here would drift, and the drift
 * would show up as a promise the registry quietly broke.
 */
export function registeredName(typed: string): string {
  return deriveTableName(typed.trim(), new Set());
}

/** The derived default: what this operation makes, from what it reads. */
export function defaultOutputName(
  operation: OperationDef,
  inputName: string | null,
  taken: (name: string) => boolean,
): string {
  const base = registeredName(
    `${inputName ?? "result"} ${operation.id.replace(/_/g, " ")}`,
  );
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken(candidate)) return candidate;
  }
  return base;
}

/**
 * A taken name, refused **before** the run and naming the conflict (G2).
 *
 * The registry's silent numeric suffix is right for an import, where the name
 * comes from a filename nobody typed, and wrong here, where they typed it. Run
 * path already refuses at admission; this is the form surfacing a refusal that
 * exists rather than inventing a rule — and it compares the name the registry
 * will use, exactly as admission does, so a name that differs only after
 * sanitizing is caught here rather than at the run.
 */
export function nameProblem(
  typed: string,
  taken: (name: string) => boolean,
): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return "The result needs a name.";
  // **The sanitizer never fails, and that is the hazard.** A name with nothing
  // usable in it does not come back empty — it comes back as the fallback
  // `table`, so a user who typed punctuation would be promised their name and
  // handed a stranger's. Refusing here is what keeps the promise honest.
  if (!/[a-z0-9]/i.test(trimmed.normalize("NFKD"))) {
    return "That name has no letters or digits in it.";
  }
  const registered = registeredName(trimmed);
  if (taken(registered)) {
    return `A table named “${registered}” already exists. An operation never ` +
      `replaces or renames around an existing table. Choose another name.`;
  }
  return null;
}

/**
 * The columns a parameter may name, of the ones the input has.
 *
 * **The catalog decides, not this module.** A parameter that declares the kind
 * of column it needs gets only those offered; one that declares none gets them
 * all. Admission checks the same rule with the same predicate, so a column the
 * form offers is never one the run refuses — and a verb a later spec adds gets
 * this for free by declaring `fieldType`.
 */
export function offeredColumns(
  parameter: OperationParameter,
  columns: { name: string; type: string }[] | null,
): { name: string; type: string }[] {
  return (columns ?? []).filter((column) =>
    suitsFieldType(column.type, parameter.fieldType),
  );
}

/**
 * The parameters a fresh form starts with: every declared default, and nothing
 * invented for a parameter that declares none.
 */
export function initialParameters(
  operation: OperationDef,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const parameter of operation.parameters) {
    if (parameter.name === "name") continue;
    if (!parameterRelevant(parameter, params)) continue;
    if (parameter.default !== undefined) params[parameter.name] = parameter.default;
    else if (
      parameter.type === "enum_list" ||
      parameter.type === "field_list" ||
      parameter.type === "column_list"
    ) {
      params[parameter.name] = [];
    }
  }
  return params;
}

/**
 * What the form is still waiting for, in the words it labels things with.
 *
 * **The list, not the boolean, is the point.** Disabling Run when something is
 * missing is right; disabling it and saying nothing is what recorded — the
 * verb's other fields look complete, the button is inert, and the one control
 * still needed carries no mark. A user's only route was to guess. The run would
 * refuse an incomplete request anyway, so this is about telling them *now*
 * rather than after a failure.
 *
 * **Each entry is a complete phrase, article included.** The caller joins them
 * into a sentence and nothing else, because a caller that prepends "a " to
 * every entry produces *"Choose a features to buffer"* for a plural input label
 * and *"Choose a a column for each carry"* for a phrase that already had one.
 * Found at the cross-model review: the template knew less about the words than
 * the place the words come from.
 *
 * Empty means ready.
 */
export function whatIsMissing(
  operation: OperationDef,
  params: Record<string, unknown>,
): string[] {
  const filled = (value: unknown) =>
    Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== null && value !== "";
  const missing: string[] = [];
  for (const input of operation.inputs) {
    if (input.required && !filled(params[input.name])) {
      // An input's label is already a phrase — "Features to buffer", "Points
      // to cluster" — and takes no article in front of it.
      missing.push(input.label.toLowerCase());
    }
  }
  for (const parameter of operation.parameters) {
    if (parameter.name === "name") continue;
    if (!parameterRelevant(parameter, params)) continue;
    // **A conditionally required parameter is required when its condition
    // holds.** A distance is needed only for a within-distance relationship,
    // and a statically optional one let the form enable Run and the server
    // refuse immediately — a form knowingly sending an invalid request.
    const conditional =
      parameter.requiredWhen !== undefined &&
      String(params[parameter.requiredWhen.parameter] ?? "") ===
        parameter.requiredWhen.equals;
    if ((parameter.required || conditional) && !filled(params[parameter.name])) {
      // A list's label is already plural — "Choose bands", never "a bands".
      missing.push(
        parameter.type === "number_list"
          ? parameterLabel(parameter.name)
          : `a ${parameterLabel(parameter.name)}`,
      );
      continue;
    }
    // **A list of carried values is not complete because it is non-empty.** An
    // aggregate other than `count` works on a column, and one with no column
    // chosen is refused by the run — which is the user finding out from a
    // failure what the form knew all along.
    if (parameter.type === "field_list" && Array.isArray(params[parameter.name])) {
      for (const entry of params[parameter.name] as unknown[]) {
        if (typeof entry !== "object" || entry === null) {
          missing.push(`a column for each ${parameterLabel(parameter.name)}`);
          break;
        }
        const { aggregate, field } = entry as Record<string, unknown>;
        if (aggregate !== "count" && !filled(field)) {
          missing.push(`a column for each ${parameterLabel(parameter.name)}`);
          break;
        }
      }
    }
  }
  return missing;
}

/**
 * Whether a parameter is part of the question at all, per the catalog's
 * served `relevantWhen`: a distance is no part of an "intersects"
 * question. The form hides what this refuses, and `activeParameters`
 * keeps it out of every request.
 */
export function parameterRelevant(
  parameter: OperationParameter,
  params: Record<string, unknown>,
): boolean {
  if (parameter.relevantWhen === undefined) return true;
  return parameter.relevantWhen.oneOf.includes(
    String(params[parameter.relevantWhen.parameter] ?? ""),
  );
}

/**
 * The parameters as the request should carry them: values of inapplicable
 * parameters stripped, so a stray 0 in a hidden distance can never draw a
 * refusal about a field the question does not contain. The typed value
 * stays in the form's own state — switching back restores it.
 */
export function activeParameters(
  operation: OperationDef,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const active = { ...params };
  for (const parameter of operation.parameters) {
    if (!parameterRelevant(parameter, params)) delete active[parameter.name];
  }
  return active;
}

/**
 * The catalog's declared bounds, enforced before the wire: a typed
 * number outside its verb's `min`/`max` never starts a dry
 * run — the form says the range instead of letting the server refuse what
 * the form knowingly sent. Fractional steps stay the server's to judge; the
 * catalog declares only the bounds.
 */
export function outOfBounds(
  operation: OperationDef,
  params: Record<string, unknown>,
): string[] {
  const sentences: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.type !== "number") continue;
    if (!parameterRelevant(parameter, params)) continue;
    const value = params[parameter.name];
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    // A ground measurement is positive — the same rule the server's own
    // admission holds, said here before the wire. The floor is
    // exclusive zero, not 1: a half-metre tolerance is legitimate.
    if (parameter.unit === "metres" && value <= 0) {
      sentences.push(
        `A ${parameterLabel(parameter.name)} is more than 0 metres.`,
      );
      continue;
    }
    if (parameter.min !== undefined && parameter.max !== undefined) {
      if (value < parameter.min || value > parameter.max) {
        sentences.push(
          `A ${parameterLabel(parameter.name)} is ${parameter.min} to ${parameter.max}.`,
        );
      }
      continue;
    }
    // A ceiling can stand alone: the ground-metre floor is exclusive zero,
    // which a served `min` cannot express, so those parameters serve only
    // `max` — and it still refuses before the wire.
    if (parameter.max !== undefined && value > parameter.max) {
      sentences.push(ceilingSentence(parameter));
    }
  }
  // The number lists: every rule is the catalog's own declaration, said
  // at the field before the dry run — a duplicate band or a fraction
  // never starts a request. One helper serves the gate and the field, so
  // the sentence the control renders is the sentence the gate refused on.
  for (const parameter of operation.parameters) {
    if (parameter.type !== "number_list") continue;
    if (!parameterRelevant(parameter, params)) continue;
    const problem = numberListProblem(parameter, params[parameter.name]);
    if (problem !== null) sentences.push(problem);
  }
  return sentences;
}

/** One sentence for a served ceiling, shared by the gate and the field so
 * the control renders exactly what the gate refused on. */
export function ceilingSentence(parameter: OperationParameter): string {
  const bound =
    parameter.unit === "metres"
      ? `${parameter.max!.toLocaleString("en-US")} metres`
      : String(parameter.max!);
  return `A ${parameterLabel(parameter.name)} is at most ${bound}.`;
}

/** The served list rules, applied to what the field holds. Null when
 * the list is valid or empty — an empty required list is *missing*, which
 * is the waiting sentence's business rather than a refusal. */
export function numberListProblem(
  parameter: OperationParameter,
  value: unknown,
): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  // The served cardinality: the control offers maxItems slots,
  // but the form is not the only caller of this logic.
  if (parameter.maxItems !== undefined && value.length > parameter.maxItems) {
    return `At most ${parameter.maxItems} ${parameterLabel(parameter.name)} values.`;
  }
  if (
    parameter.minItems !== undefined &&
    parameter.minItems > 1 &&
    value.length < parameter.minItems
  ) {
    return `At least ${parameter.minItems} ${parameterLabel(parameter.name)} values.`;
  }
  const floor = parameter.itemMin ?? 1;
  const broken = value.find(
    (item) =>
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      (parameter.itemInteger === true && !Number.isInteger(item)) ||
      item < floor,
  );
  if (broken !== undefined) {
    return (
      `Each ${parameterLabel(parameter.name)} value is a whole number of ` +
      `at least ${floor}.`
    );
  }
  if (parameter.itemsUnique === true && new Set(value).size !== value.length) {
    const seen = new Set<number>();
    const repeated = value.find((item) => {
      if (seen.has(item as number)) return true;
      seen.add(item as number);
      return false;
    });
    return `Each value is asked once. ${repeated} appears twice.`;
  }
  return null;
}

/** The words the form itself puts on a parameter, so the reason names the
 * control the user is looking at rather than an identifier they never see. */
export function parameterLabel(name: string): string {
  return name.replace(/_/g, " ");
}

/** Whether every required input and parameter has a value. The run would
 * refuse an incomplete request anyway; this is what stops the user finding
 * that out from a failed run. */
export function isComplete(
  operation: OperationDef,
  params: Record<string, unknown>,
): boolean {
  return whatIsMissing(operation, params).length === 0;
}


/**
 * Which workspace tables a layer's SQL reads — the door's pre-fill.
 *
 * **This is a suggestion, not a resolution**, and it is deliberately the
 * over-matching kind: it matches registered names as whole words in the
 * layer's SQL. The user sees the result in the picker and can change it, so an
 * over-match costs a correction rather than a wrong run. The exact answer lives
 * in the engine's parser, server-side, and is not reachable from here without
 * inventing an endpoint this spec is not allowed to add.
 */
export function tablesNamedIn(
  sql: string,
  tables: TableListing[],
): TableListing[] {
  const text = sql.toLowerCase();
  return tables.filter((table) =>
    new RegExp(`\\b${escapeRegExp(table.name.toLowerCase())}\\b`).test(text),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the door can pre-fill for a verb whose input is a **table name**.
 *
 * `fromLayerId` captures the layer's filtered SQL into the step's `sql`
 * parameter, which only the SQL step consumes — every other verb names a
 * registered table. So the door pre-fills the table the layer reads, and says
 * plainly where that differs from what the layer draws: a filtered layer's
 * table holds rows the layer does not show, and the SQL step is the route that
 * carries the filters.
 */
export function prefillNote(
  layer: { sql: string; filters?: unknown[] } | null,
  resolved: TableListing[],
): string | null {
  if (!layer) return null;
  if (resolved.length === 0) {
    return (
      "This layer's SQL does not read a single workspace table, so there is " +
      "nothing to pre-fill. Use the SQL step to carry the layer's own query."
    );
  }
  if (resolved.length > 1) {
    return (
      "This layer reads more than one table. Pick the one this step should " +
      "run on."
    );
  }
  if ((layer.filters?.length ?? 0) > 0) {
    return (
      `This layer has ${layer.filters!.length} filter` +
      `${layer.filters!.length === 1 ? "" : "s"}. A step reading the table ` +
      `reads all of it. Use the SQL step to carry the filtered rows instead.`
    );
  }
  return null;
}

/**
 * What an empty recipe offers.
 *
 * **Four verbs that fit the input's geometry**, and it says they are
 * suggestions. The ratified cost is named and accepted: a suggestion list is an
 * opinion, and a wrong one costs more than a neutral catalog — which is why
 * *Browse all operations* sits beside it rather than behind it.
 *
 * The fit is the catalog's own `accepts`, so a verb a later spec adds is
 * suggested for the geometry it declares, without this rule changing.
 */
export function suggestedOperations(
  operations: OperationDef[],
  /** The class the recipe's input holds, or null when nothing is known. */
  geometry: "point" | "line" | "polygon" | null,
  limit = 4,
): OperationDef[] {
  const fits = (operation: OperationDef) => {
    if (geometry === null) return true;
    return operation.accepts.includes("any") || operation.accepts.includes(geometry);
  };
  return operations.filter(fits).slice(0, limit);
}

/**
 * A working surface's help line: the first sentence of a served
 * description, markdown stripped. The full text is the docs page's; a form
 * is not a tutorial, and the one thing a measured parameter must still say
 * — ground metres — survives because it is said in the first sentence.
 */
export function helpLine(text: string): string {
  const plain = text.replace(/\*\*?|`/g, "");
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(plain);
  return (match ? match[0] : plain).trim();
}

/** The empty list's field sentence: rendered by the
 * control once the field has been touched — a pristine form is asked, not
 * scolded — while the gate holds either way through `whatIsMissing`. */
export function emptyListSentence(parameter: OperationParameter): string {
  const min = parameter.minItems ?? 1;
  return `At least ${min} value${min === 1 ? "" : "s"}.`;
}
