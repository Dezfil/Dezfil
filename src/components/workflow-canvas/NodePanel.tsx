"use client";

import { useEffect, useMemo } from "react";
import type { OperationDef, OperationParameter } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { XIcon } from "../ui/icons";
import { OperationGlyph } from "../ui/operation-icons";
import { ParameterRow } from "../builder/drawer/parameter-controls";
import {
  nameProblem,
  outOfBounds,
  parameterLabel,
  parameterRelevant,
  registeredName,
  whatIsMissing,
} from "../builder/drawer/operation-form";
import { useDryRun } from "../builder/drawer/use-dry-run";
import { normalName } from "../workflow-producers";
import { effectiveParameters, type CanvasGraph, type NodeMember } from "./graph";
import { outputNameTaken, readerAddressOf } from "./home-names";
import { expectedClass } from "./link-rules";
import { callouts, pickerOptions, unproducedOutput } from "./node-panel-model";
import { InputPicker } from "./InputPicker";
import { usePanelDraft, type Draft } from "./use-panel-draft";
import { GeometryGlyph } from "../ui/operation-icons";
import { RunSection } from "./RunSection";
import { OutputFacts } from "./OutputFacts";
import { useCanvasRecovery } from "./WorkflowRecovery";
import { useTemplateCanvas } from "./template-canvas";
import { UnsavedMark } from "../builder/UnsavedFields";
import styles from "./WorkflowCanvas.module.css";

/**
 * The node panel: the operation, the API's callouts order, one picker per
 * input, Reads for the SQL node, every parameter shape under the drawer's
 * rules and words, the output's name under the name rule, the dry run's
 * preview beside the produced output's facts, and Remove node.
 *
 * **What is typed stays typed.** The panel holds a draft of the node's
 * effective definition; each accepted change lands as made through the
 * edit coordinator, a refused one keeps the field's value and shows the
 * API's reason at the field, and a locally invalid one is never sent.
 */

export function NodePanel({
  recipeId,
  member,
  graph,
  operations,
  tables,
  onClose,
  onRemove,
  lockReason = null,
}: {
  /** The workflow the node is in: its dry run binds where the run will. */
  recipeId: string;
  member: NodeMember;
  graph: CanvasGraph;
  operations: OperationDef[];
  tables: TableListing[];
  onClose: () => void;
  onRemove: (member: NodeMember) => void;
  /** The canvas lock's reason while locked: the definition reads, nothing edits. */
  lockReason?: string | null;
}) {
  const { stale } = useCanvasRecovery();
  // A template's step reads nothing of a dataset's and is never tried: its
  // data is no one's, and it never runs.
  const template = useTemplateCanvas() !== null;
  const step = member.step;
  const operation = operations.find((o) => o.id === step.operation) ?? null;
  const effective = useMemo(() => effectiveParameters(step), [step]);

  // The draft, the debounce, the flush and Discard edit: the panel's own
  // hook (where a field's focus session is minted).
  const { values, refusals, set, discard, sent, setInvalid } = usePanelDraft({ step, operation, effective });

  // An unsettled member of the run in flight is read-only until it settles: the run callout says
  // why; the controls are inert.
  const unsettled = member.run !== null && (member.run.word === "waiting" || member.run.word === "queued" || member.run.word === "running");
  // Inert for the run in flight or the lock: the
  // fieldsets are disabled, each with its reason.
  const inert = unsettled || lockReason !== null;
  const inertReason = unsettled ? "It is part of the run in flight." : lockReason;
  // ---- the name rule ----
  const produced = step.output !== null;
  const typedName = typeof values.name === "string" ? values.name : "";
  const siblingHolder = graph.members.find(
    (m) => m.kind === "node" && m.id !== member.id && normalName(m.outputName) === normalName(registeredName(typedName || "x")),
  );
  // Taken where the output lands or would shadow: the home or the reader's own space.
  const tableTaken = outputNameTaken(tables, graph.home);
  const nameIssue = produced
    ? null
    : (nameProblem(typedName, tableTaken) ??
      (siblingHolder && siblingHolder.kind === "node" && typedName.trim() !== ""
        ? `Another node of this workflow (${siblingHolder.label}) already declares "${registeredName(typedName)}". Choose another name.`
        : null));

  // ---- the drawer's rules on the draft (9) ----
  const missing = operation ? whatIsMissing(operation, values) : [];
  const astray = operation ? outOfBounds(operation, values) : [];
  // The Output section names the field that is invalid; the sentence
  // itself is said once, at the field.
  const invalid = operation
    ? operation.parameters
        .filter((p) => p.type === "number" || p.type === "number_list")
        .filter((p) => {
          const alone: Draft = { ...values };
          for (const q of operation.parameters) if (q.name !== p.name && (q.type === "number" || q.type === "number_list")) delete alone[q.name];
          return outOfBounds(operation, alone).length > 0;
        })
        .map((p) => parameterLabel(p.name))
    : [];
  const complete = operation !== null && missing.length === 0 && astray.length === 0 && nameIssue === null;
  useEffect(() => {
    setInvalid(
      astray.length > 0
        ? `Fix the ${invalid.join(" and the ")} first: ${astray.join(" ")}`
        : nameIssue
          ? `Fix the name first: ${nameIssue}`
          : null,
    );
  });

  const firstInput = operation?.inputs[0] ?? null;
  // A field parameter names the columns of the input the catalog declares
  // for it (a join's right key reads the right table), else the first,
  // asked for as the reader addresses the dataset the input names.
  const tableFor = (parameter: OperationParameter): string | null => {
    const port = parameter.ofInput ?? firstInput?.name ?? null;
    const name = port && typeof values[port] === "string" ? (values[port] as string) : null;
    if (template || !name || unproducedOutput(name, graph, tables)) return null;
    return readerAddressOf(name, graph, tables);
  };
  const unproducedInputs = operation
    ? operation.inputs
        .map((i) => (typeof values[i.name] === "string" ? (values[i.name] as string) : null))
        .filter((n): n is string => n !== null && unproducedOutput(n, graph, tables))
    : [];
  const producedTable = step.output ? (tables.find((t) => t.id === step.output!.id) ?? null) : null;
  // An input that names an output nothing has produced yet: the dry run
  // would only find the table missing, so it is not asked; the preview
  // says it comes after that node runs.
  // The SQL node's reads are the API's, for the definition it holds: they
  // are consulted while the draft's query is that definition's.
  const sqlReads = member.sql && values.sql === effective.sql ? step.reads : [];
  const waitingOn = [
    ...(operation?.inputs ?? []).map((i) => (typeof values[i.name] === "string" ? (values[i.name] as string) : null)),
    ...sqlReads,
  ].find((n) => unproducedOutput(n, graph, tables));
  // The dry run reads the node's parameters in the workflow's context, its
  // SQL home and declared outputs, so the preview binds like the run will.
  const gate = useDryRun(
    complete && operation && !waitingOn && !template
      ? { operation: operation.id, parameters: withoutName(sent), writtenIn: { kind: "workflow", id: recipeId } }
      : null,
  );
  const expected = expectedClass(member, graph, operations, tables);

  const marks = callouts(member, operation);
  const sqlNode = member.sql;

  return (
    <aside className={styles.inspector} aria-label={`${member.label}, node`} data-node-panel data-step-id={step.id}>
      <header className={styles.inspHead}>
        <span className={styles.inspTile} data-group={member.group ?? undefined}>
          <OperationGlyph symbol={member.symbol} />
        </span>
        <h3>{member.label}</h3>
        <IconButton action="Close panel" icon={<XIcon />} onClick={onClose} />
      </header>
      <div className={styles.inspBody}>
        {lockReason ? (
          <p className={styles.help} role="status" id="panel-lock-reason" data-lock-reason>
            {lockReason}
          </p>
        ) : null}
        {marks.map((c) => (
          <div key={c.key} className={styles.callout} data-tone={c.tone === "plain" ? undefined : c.tone} data-callout={c.key}>
            <b>{c.head}</b>
            {c.body ? ` ${c.body}` : null}
            {c.mono ? <span className={styles.mono}>{c.mono}</span> : null}
            {c.changes?.map((ch) => (
              <div key={ch.name} className={styles.changeRow}>
                <span>{ch.name}</span>
                <span className={styles.was}>{ch.was}</span>
                <span className={styles.now}>{ch.now}</span>
              </div>
            ))}
            {c.key === "edited" ? (
              <div className={styles.calloutActions}>
                <Button variant="quiet" size="compact" onClick={discard} disabled={lockReason !== null} aria-describedby={lockReason ? "panel-lock-reason" : undefined} data-discard-edit>
                  Discard edit
                </Button>
              </div>
            ) : null}
          </div>
        ))}

        <fieldset className={styles.inert} disabled={inert} data-inert={inert || undefined} aria-describedby={lockReason ? "panel-lock-reason" : undefined}>
        {operation && operation.inputs.length > 0 ? (
          <section className={styles.sec} aria-label="Inputs">
            <h4 className={styles.secLabel}>Inputs</h4>
            {operation.inputs.map((input) => {
              const current = typeof values[input.name] === "string" ? (values[input.name] as string) : "";
              const options = pickerOptions({ to: member, port: input.name, graph, operations, tables });
              // The accepted kinds as glyphs: `any` reads as the three and
              // a table without geometry.
              const kinds = input.accepts.includes("any") ? ["point", "line", "polygon", "none"] : [...input.accepts];
              return (
                <div key={input.name} className={styles.sec}>
                  <label className={styles.secLabel} htmlFor={`input-${input.name}`} style={{ fontWeight: 500 }}>
                    {input.label}{stale && values[input.name] !== effective[input.name] && <UnsavedMark />}
                  </label>
                  <div className={styles.inputPick}>
                    <InputPicker
                      id={`input-${input.name}`}
                      name={input.name}
                      label={input.label}
                      current={current || null}
                      options={options}
                      disabled={inert}
                      disabledReason={inertReason}
                      onPick={(value) => set(input.name, value ?? undefined, true)}
                    />
                    {current ? (
                      <IconButton
                        action={`Detach ${input.label}`}
                        icon={<XIcon />}
                        onClick={() => set(input.name, undefined, true)}
                        data-detach={input.name}
                      />
                    ) : null}
                  </div>
                  <div className={styles.accepts} aria-label={`Accepts ${kinds.map(kindWord).join(", ")}`} data-accepts={kinds.join(" ")}>
                    {kinds.map((k) => (
                      <span key={k} className={styles.acceptGlyph} data-kind={k === "none" ? "none" : "spatial"} title={kindWord(k)}>
                        <GeometryGlyph geometryType={k === "point" ? "POINT" : k === "line" ? "LINESTRING" : k === "polygon" ? "POLYGON" : null} />
                      </span>
                    ))}
                  </div>
                  {input.description ? <p className={styles.help}>{input.description}</p> : null}
                  {refusals[input.name] ? (
                    <p className={styles.problem} role="alert">
                      {refusals[input.name]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        {sqlNode ? (
          <section className={styles.sec} aria-label="Reads">
            <h4 className={styles.secLabel}>
              Reads <span className={styles.cnt}>{step.reads.length}</span>
            </h4>
            {step.reads.length ? (
              <div className={styles.chips}>
                {step.reads.map((r) => (
                  <span key={r} className={styles.chip}>
                    {r}
                  </span>
                ))}
              </div>
            ) : (
              <p className={styles.help}>Nothing yet.</p>
            )}
            <p className={styles.help}>Taken from the query. Change the query to read something else.</p>
          </section>
        ) : null}

        {operation ? (
          <section className={styles.sec} aria-label="Parameters">
            <h4 className={styles.secLabel}>Parameters</h4>
            {unproducedInputs.map((n) => (
              <p key={n} className={styles.help}>
                Columns of {n} come after its node runs.
              </p>
            ))}
            {operation.parameters
              .filter((p) => p.name !== "name" && parameterRelevant(p, values))
              .map((parameter) => (
                <div key={parameter.name}>
                  {stale && JSON.stringify(values[parameter.name]) !== JSON.stringify(effective[parameter.name]) && <UnsavedMark />}
                  <ParameterRow
                    parameter={parameter}
                    value={values[parameter.name]}
                    ofInputTable={tableFor(parameter)}
                    onChange={(value) => {
                      const next = { ...values, [parameter.name]: value };
                      const valid = outOfBounds(operation, next).length === 0;
                      set(parameter.name, value, valid);
                    }}
                  />
                  {refusals[parameter.name] ? (
                    <p className={styles.problem} role="alert" data-refusal={parameter.name}>
                      {refusals[parameter.name]}
                    </p>
                  ) : null}
                </div>
              ))}
            {operation.parameters.filter((p) => p.name !== "name").length === 0 ? <p className={styles.help}>Nothing to set.</p> : null}
          </section>
        ) : null}

        </fieldset>
        <section className={styles.sec} aria-label="Output">
          <h4 className={styles.secLabel}>Output</h4>
          <fieldset className={styles.inert} disabled={inert} data-inert={inert || undefined} aria-describedby={lockReason ? "panel-lock-reason" : undefined}>
          <div className={styles.sec}>
            <label className={styles.secLabel} htmlFor="output-name" style={{ fontWeight: 500 }}>
              Dataset name{stale && values.name !== effective.name && <UnsavedMark />}
            </label>
            <input
              id="output-name"
              className={styles.nameInput}
              data-param="name"
              value={typedName}
              disabled={produced}
              aria-invalid={nameIssue !== null || undefined}
              onChange={(e) => {
                const typed = e.target.value;
                const holder = graph.members.find(
                  (m) => m.kind === "node" && m.id !== member.id && normalName(m.outputName) === normalName(registeredName(typed || "x")),
                );
                const ok = nameProblem(typed, tableTaken) === null && !(holder && typed.trim() !== "");
                set("name", typed, ok);
              }}
            />
            {produced ? (
              <p className={styles.help}>The dataset keeps its name after the first run.</p>
            ) : nameIssue ? (
              <p className={styles.problem} role="alert" data-name-problem>
                {nameIssue}
              </p>
            ) : refusals.name ? (
              <p className={styles.problem} role="alert" data-name-problem>
                {refusals.name}
              </p>
            ) : null}
            {!produced && !nameIssue && typedName && registeredName(typedName) !== typedName.trim() ? (
              <p className={styles.help}>Registered as {registeredName(typedName)}.</p>
            ) : null}
          </div>

          </fieldset>

          {/* The facts and the map door stand between the inert parts:
              the action changes a map, never the node. */}
          {produced ? <OutputFacts step={step} outputName={member.outputName} table={producedTable} /> : null}

          {template ? null : (
          <fieldset className={styles.inert} disabled={inert} data-inert={inert || undefined} aria-describedby={lockReason ? "panel-lock-reason" : undefined}>
          <div className={styles.sec} data-preview>
            <h4 className={styles.secLabel} style={{ fontWeight: 500 }}>
              {produced ? "Would make on the next run" : "Would make"}
            </h4>
            {!complete ? (
              <p className={styles.help} data-preview-blocked>
                {missing.length
                  ? `Choose ${missing.join(", ")}.`
                  : invalid.length
                    ? `Fix the ${invalid.join(" and the ")} first.`
                    : nameIssue
                      ? "Fix the name first."
                      : ""}
              </p>
            ) : waitingOn ? (
              <p className={styles.help} data-preview-waiting>
                The preview comes after {waitingOn} is produced.
              </p>
            ) : gate.state === "checking" || gate.state === "waiting" ? (
              <p className={styles.help} role="status" data-preview-checking>
                Checking what this will produce…
              </p>
            ) : gate.state === "refused" ? (
              <p className={styles.problem} role="alert" data-preview-refusal>
                {gate.message}
              </p>
            ) : (
              <>
                <p className={styles.previewLine} role="status" data-preview-line>
                  <b>{gate.preview.rowCount.toLocaleString()} rows</b>
                  {" · "}
                  {gate.preview.geometry === "none"
                    ? "no geometry: a table, not a layer"
                    : gate.preview.geometry === "undetermined"
                      ? "spatial, class undetermined: no geometries to classify"
                      : (gate.preview.geometryType ?? "spatial")}
                </p>
                {gate.preview.warnings.map((w) => (
                  <p key={w} className={styles.help} role="status" data-preview-warning>
                    {w}
                  </p>
                ))}
              </>
            )}
            {!complete && expected !== "unknown" ? (
              <p className={styles.help}>Geometry: {expected === "none" ? "none, a table" : expected}.</p>
            ) : null}
          </div>
          </fieldset>
          )}
        </section>
        <RunSection member={member} graph={graph} />
        <div className={styles.btnRow}>
          {unsettled ? (
            <p className={styles.help} data-remove-withheld>
              It is part of the run in flight. It can be removed once it settles.
            </p>
          ) : lockReason ? (
            <p className={styles.help} data-remove-withheld>
              {lockReason}
            </p>
          ) : (
            <Button variant="quiet" size="compact" className={styles.removeBtn} onClick={() => onRemove(member)} data-remove-node>
              Remove node
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The word a kind glyph carries for assistive technology and the hover. */
function kindWord(kind: string): string {
  return kind === "none" ? "a table without geometry" : `${kind} geometry`;
}

function withoutName(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(parameters).filter(([k]) => k !== "name"));
}
