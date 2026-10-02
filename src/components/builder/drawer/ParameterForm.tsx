"use client";

import { useMemo, useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../../api";
import { ErrorNote } from "../../ui/ErrorNote";
import { Spinner } from "../../Spinner";
import { acceptsTable, geometryClass } from "./derived-tables";
import {
  defaultOutputName,
  helpLine,
  activeParameters,
  initialParameters,
  outOfBounds,
  parameterRelevant,
  whatIsMissing,
  nameProblem,
  prefillNote,
  registeredName,
  tablesNamedIn,
} from "./operation-form";

import type { RecipeSummary } from "./recipe-model";
import { ParameterRow } from "./parameter-controls";
import { TablePicker } from "./TablePicker";
import { useDryRun, type DryRunGate, type DryRunPreview } from "./use-dry-run";
import { filteredSql } from "@/lib/query/compile";
import type { LayerFilter } from "@/lib/viz";
import styles from "./ParameterForm.module.css";

/**
 * The parameter form and its Result section.
 *
 * **This is the flagship moment of the phase** — what happens when the user
 * presses Run — and the record's amendment A1 decided its shape: a labelled
 * two-column grid rather than 05's plain sentence, on the readability argument
 * that the two facts deciding whether an operation is legal (each candidate
 * input's feature count and geometry class) are visible *before* the picker
 * opens, which the sentence could not do.
 *
 * The Result section carries an editable output **Table name** whose promise
 * is kept — the name shown is the name the registry will use — and the
 * sentence saying what the run makes: a dataset always, a layer wherever the
 * layer service accepts the result. The *On the map* checkbox is retired by
 * the one-step pivot; the dry run's answer is what lets the table-only case be
 * said before Run rather than discovered after it.
 */

/** The aggregates a carried value can take. Type-checked against the engine's
 * own union, so a seventh added server-side fails this build rather than
 * quietly disappearing from the form. */

export interface AuthoredStep {
  operation: string;
  parameters: Record<string, unknown>;
  /** Author from this layer, so the API captures its filtered SQL. Only the
   * SQL step consumes it; every other verb names a table. */
  fromLayerId?: string;
  /** D1's derived display name — what the layer is called wherever the
   * layer service accepts the result. The *On the map* checkbox is
   * retired: a mappable result becomes a layer in the same gesture,
   * always, and the server's own boundary decides mappability. */
  displayName: string;
}

export function ParameterForm({
  operation,
  tables,
  recipes,
  mapId,
  originLayer,
  busy,
  error,
  onRun,
  onDirtyChange,
}: {
  operation: OperationDef;
  tables: TableListing[];
  recipes: RecipeSummary[];
  /** The map being built — the sketches group needs it. */
  mapId?: string | null;
  /** The layer the door arrived through, when it did. */
  originLayer: { id: string; name: string; sql: string; filters?: unknown[] } | null;
  busy: boolean;
  error: string | null;
  onRun: (step: AuthoredStep) => void;
  /** Whether the form holds edits, so a dismissal can be tested against the
   * rider that says it raises no blocking confirmation. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const prefilled = useMemo(
    () => (originLayer ? tablesNamedIn(originLayer.sql, tables) : []),
    [originLayer, tables],
  );
  const firstInput = operation.inputs[0];
  const [params, setParams] = useState<Record<string, unknown>>(() => {
    const start = initialParameters(operation);
    // **The door pre-fills the input**: one resolved table, one
    // declared input, **and the table compatible with what the input
    // accepts** — a locked-in value the run must refuse is worse than an
    // empty field with the note saying why.
    if (
      firstInput &&
      prefilled.length === 1 &&
      acceptsTable(firstInput.accepts, prefilled[0])
    ) {
      start[firstInput.name] = prefilled[0].name;
    }
    return start;
  });

  // **The pre-fill survives a late table list.** `/api/tables` can answer
  // after the form is open, and a suggestion computed only at the first render
  // would leave *Analyze…* without the input it promised for the rest of the
  // session. Adjusting during render rather than in an effect, per React's own
  // derived-state pattern.
  const suggestion =
    firstInput &&
    prefilled.length === 1 &&
    acceptsTable(firstInput.accepts, prefilled[0])
      ? prefilled[0].name
      : null;
  const [applied, setApplied] = useState<string | null>(suggestion);
  if (
    firstInput &&
    suggestion !== null &&
    suggestion !== applied &&
    !params[firstInput.name]
  ) {
    setApplied(suggestion);
    setParams((was) => ({ ...was, [firstInput.name]: suggestion }));
  }
  const chosen = firstInput ? params[firstInput.name] : undefined;
  const inputName =
    typeof chosen === "string" ? chosen : (prefilled[0]?.name ?? null);
  const taken = useMemo(
    () => (name: string) =>
      tables.some((t) => t.name.toLowerCase() === name.toLowerCase()),
    [tables],
  );
  const [name, setName] = useState(() =>
    defaultOutputName(operation, inputName, taken),
  );
  // **The derived default follows the input until the user takes it over.**
  // A name settled before an input was chosen reads `result_buffer` for ever,
  // which is not the specified default. Once they type, it is theirs.
  const [nameEdited, setNameEdited] = useState(false);
  /** The layer a Select pick arrived through (D1): a
   * topbar-started action whose input came from Select names its result
   * from the picked layer, not from the snake_case table. */
  const [pickedLayer, setPickedLayer] = useState<string | null>(null);
  const [namedFor, setNamedFor] = useState(inputName);
  if (namedFor !== inputName) {
    setNamedFor(inputName);
    if (!nameEdited) setName(defaultOutputName(operation, inputName, taken));
  }
  const problem = nameProblem(name, taken);
  const registered = registeredName(name);
  /**
   * D1's derived display name: the contextual layer's name when the input
   * arrived through the door, otherwise a readable form of the primary
   * input, with the served tool label — “Stations (Buffer)”.
   */
  const displayBase =
    originLayer?.name ??
    pickedLayer ??
    (inputName ? inputName.replace(/_/g, " ") : registered.replace(/_/g, " "));
  const displayName = `${displayBase} (${operation.label})`;

  /**
   * **The door's route into a verb whose input is SQL**.
   *
   * `fromLayerId` captures the layer's filtered SQL server-side, so the field
   * stays empty here rather than being filled with something this surface
   * cannot compute. Typing a query instead is the override — a caller who
   * wrote SQL meant that SQL, and sending the layer id anyway would overwrite
   * it on the way out.
   */
  const layerSql =
    originLayer !== null &&
    operation.inputs.length === 0 &&
    operation.parameters.some((p) => p.name === "sql") &&
    String(params.sql ?? "").trim() === "";
  const missing = whatIsMissing(
    operation,
    layerSql ? { ...params, sql: "from the layer" } : params,
  );
  // A number outside its declared bounds blocks the gate exactly like an
  // absent one — the dry run never fires on a value the catalog already
  // refuses. The sentence renders at the field itself.
  const astray = outOfBounds(operation, params);
  const complete = missing.length === 0 && problem === null && astray.length === 0;

  /**
   * **The dry run gates Run**: the check fires once the form is complete and
   * Run arms only when its answer matches the current values. For the door's
   * SQL route the check previews **the same filtered snapshot the committed
   * run captures server-side** — `filteredSql` is the one composition both
   * sides call, which is what makes the preview the run's equal rather than
   * its estimate.
   */
  const sent = activeParameters(operation, params);
  const gate: DryRunGate = useDryRun(
    complete
      ? {
          operation: operation.id, ...(layerSql && mapId ? { writtenIn: { kind: "map" as const, id: mapId } } : {}),
          parameters: layerSql
            ? {
                ...sent,
                sql: filteredSql(
                  originLayer!.sql,
                  (originLayer!.filters ?? []) as LayerFilter[],
                ),
              }
            : sent,
        }
      : null,
  );
  const preview = gate.state === "ready" ? gate.preview : null;
  const ready = complete && preview !== null;
  /**
   * The steady display (field round): a slider drag fires one re-check per
   * debounce, and a display tied to the gate flashed the row count and the
   * assumed-CRS warning out and in on every notch. The last answer holds on
   * screen while the next one is measured — only Run waits for fresh truth.
   * The held answer belongs to the inputs it was measured on — every
   * declared table input, since a Union's second table changing is as much
   * a new measurement as its first — so a changed input drops
   * it rather than showing another table's numbers.
   */
  const inputsKey = [
    ...operation.inputs.map((input) => String(params[input.name] ?? "")),
    // The SQL verb declares no inputs — its source rides the query itself,
    // so an edited query is a new measurement too.
    operation.parameters.some((parameter) => parameter.name === "sql")
      ? String(params.sql ?? "")
      : "",
  ].join("\u0000");
  const [held, setHeld] = useState<{
    inputs: string;
    preview: DryRunPreview;
  } | null>(null);
  if (preview && held?.preview !== preview) {
    setHeld({ inputs: inputsKey, preview });
  } else if (held && held.inputs !== inputsKey) {
    setHeld(null);
  }
  const shown =
    preview ??
    (gate.state === "checking" && held?.inputs === inputsKey
      ? held.preview
      : null);
  /**
   * Why Run is disabled, in the words the form labels things with.
   *
   * A disabled button that says nothing is the roughness the registry row
   * recorded: the verb's other fields look complete, the button is inert, and
   * the control still needed carries no mark. `problem` already has its own
   * sentence, so this only speaks when the reason is *absence*.
   *
   * **The phrases arrive complete**, articles and all, and this only joins
   * them. Prepending "a " here produced *"Choose a features to buffer"* on any
   * verb whose input label is plural — found at the cross-model review.
   */
  const waitingFor =
    problem !== null || missing.length === 0
      ? null
      : `Choose ${
          missing.length === 1
            ? missing[0]
            : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`
        } to run this.`;

  const set = (key: string, value: unknown) => {
    onDirtyChange?.(true);
    setParams((was) => ({ ...was, [key]: value }));
  };

  return (
    <div className={styles.form} data-parameter-form={operation.id}>
      {/* The blurb, not the reference text; the title and back live on
          the face header now. */}
      <p className={styles.description}>{operation.blurb}</p>
      <div className={styles.grid}>
        {operation.inputs.map((input) => (
          <div key={input.name} className={styles.field}>
            <label className={styles.label}>{input.label}</label>
            <div className={styles.control}>
              <p className={styles.help}>{helpLine(input.description)}</p>
              <TablePicker
                label={input.label}
                tables={tables}
                recipes={recipes}
                mapId={mapId}
                accepts={input.accepts}
                onPickContext={
                  input === firstInput ? setPickedLayer : undefined
                }
                value={
                  typeof params[input.name] === "string" &&
                  params[input.name] !== ""
                    ? (params[input.name] as string)
                    : null
                }
                onPick={(picked) => set(input.name, picked)}
              />
            </div>
          </div>
        ))}
        {operation.parameters
          .filter((p) => p.name !== "name" && parameterRelevant(p, params))
          .map((parameter) => (
            <ParameterRow
              key={parameter.name}
              parameter={parameter}
              value={params[parameter.name]}
              ofInputTable={
                parameter.ofInput && typeof params[parameter.ofInput] === "string"
                  ? (params[parameter.ofInput] as string)
                  : null
              }
              onChange={(value) => set(parameter.name, value)}
            />
          ))}
      </div>

      {originLayer && (
        <p className={styles.prefill} data-prefill-note>
          {layerSql
            ? `This step will run the layer “${originLayer.name}”’s own query, filters and all, exactly as it is now. Type a query above to use that instead.`
            : firstInput &&
                prefilled.length === 1 &&
                !acceptsTable(firstInput.accepts, prefilled[0])
              ? `“${originLayer.name}” holds ${geometryClass(prefilled[0])}, which this tool does not take. Choose the input yourself.`
              : (prefillNote(originLayer, prefilled) ??
                `Pre-filled from the layer “${originLayer.name}”.`)}
        </p>
      )}

      {/* The Result section: the last thing read before Run. */}
      <section className={styles.result} data-result-section>
        <p className={styles.eyebrow}>Result</p>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="recipe-output-name">
            Table name
          </label>
          <div className={styles.control}>
            <input
              id="recipe-output-name"
              className={styles.text}
              data-output-name
              value={name}
              onChange={(e) => {
                onDirtyChange?.(true);
                setNameEdited(true);
                setName(e.target.value);
              }}
            />
            {registered !== name.trim() && registered !== "" && (
              <p className={styles.help}>
                Registered as <strong>{registered}</strong>.
              </p>
            )}
            {problem && (
              <p className={styles.problem} data-name-problem role="alert">
                {problem}
              </p>
            )}
          </div>
        </div>
        {/* **What the run makes, said before Run**. The
            table-only case is known from the catalog where the verb declares
            no geometry, and from the dry run where only a probe can tell;
            either way the sentence is on screen before the gesture, and no
            map action is offered that cannot succeed. */}
        <p className={styles.help} data-result-note>
          {operation.outputGeometry.kind === "none" ||
          preview?.geometry === "none"
            ? "Saved as a dataset. No layer: this result has no geometry."
            : operation.outputGeometry.kind === "fixed" || preview
              ? "Saved as a dataset and added to the map."
              : // Probed or input-following geometry is not known until the
                // dry run answers — the sentence completes when it does, and Run cannot arm before
                // then anyway.
                "Saved as a dataset."}
        </p>
      </section>

      {waitingFor && (
        <p className={styles.waiting} data-form-waiting role="status">
          {waitingFor}
        </p>
      )}

      {/* The gate's answer, where the eye already is before Run. */}
      {complete && gate.state === "checking" && !shown && (
        <p className={styles.waiting} data-dry-checking role="status">
          Checking what this will produce…
        </p>
      )}
      {shown && (
        <p className={styles.dryline} data-dry-run role="status">
          Dry run: <strong>{shown.rowCount.toLocaleString()} rows</strong>
          {" · "}
          {shown.geometry === "none"
            ? "no geometry: a table, not a layer"
            : shown.geometry === "undetermined"
              ? "spatial, class undetermined: no geometries to classify"
              : (shown.geometryType ?? "spatial")}
        </p>
      )}
      {shown?.warnings.map((warning) => (
        <p key={warning} className={styles.warning} data-dry-warning role="status">
          {warning}
        </p>
      ))}
      {gate.state === "refused" && (
        <p className={styles.problem} data-dry-refusal role="alert">
          {gate.message}
        </p>
      )}

      {/* **A refusal renders where the user is looking** — beside
          the action that was refused, with every entered value preserved and
          the same form retryable. */}
      {error && <ErrorNote message={error} data-form-error />}

      <div className={styles.actions}>
        <button
          className={styles.run}
          data-form-run
          disabled={!ready || busy}
          onClick={() =>
            onRun({
              operation: operation.id,
              parameters: { ...sent, name },
              ...(layerSql && originLayer ? { fromLayerId: originLayer.id } : {}),
              displayName,
            })
          }
        >
          {busy ? <Spinner /> : null} Run
        </button>
      </div>
    </div>
  );
}

/** One labelled row of the grid, rendered from what the catalog declares. */
