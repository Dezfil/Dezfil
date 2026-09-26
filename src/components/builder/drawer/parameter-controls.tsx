"use client";

import { useState } from "react";
import type { OperationParameter } from "@/lib/operations/catalog";
import type { Aggregate } from "@/lib/operations/spatial-join";
import { Switch } from "../../ui/Switch";
import {
  ceilingSentence,
  emptyListSentence,
  helpLine,
  numberListProblem,
  offeredColumns,
} from "./operation-form";
import { useTableColumns } from "./use-operations";
import styles from "./ParameterForm.module.css";

/**
 * The catalog-driven parameter controls: one row per parameter shape the
 * catalog declares — string, SQL text, number with its bounds and slider,
 * number list, boolean, enum, enum list, column list, field, and the
 * carried values with their aggregates — under the catalog's rules and the
 * drawer's words. The drawer's authoring form and the workflow canvas's
 * node panel compose these; neither owns them, so a verb a later spec adds
 * gets the same control in both.
 */

const AGGREGATES: Aggregate[] = ["count", "sum", "mean", "min", "max", "any"];
type MissingAggregate = Exclude<Aggregate, (typeof AGGREGATES)[number]>;
const _everyAggregateOffered: MissingAggregate extends never ? true : false = true;
void _everyAggregateOffered;

export function ParameterRow({
  parameter,
  value,
  ofInputTable,
  onChange,
}: {
  parameter: OperationParameter;
  value: unknown;
  /** The table whose columns a field parameter names. */
  ofInputTable: string | null;
  onChange: (value: unknown) => void;
}) {
  const { columns: held } = useTableColumns(
    parameter.type === "field" ||
      parameter.type === "field_list" ||
      parameter.type === "column_list"
      ? ofInputTable
      : null,
  );
  // Only the columns this parameter can actually take — the catalog says which
  // kind it needs, and offering the rest would be the form knowingly proposing
  // something the run refuses.
  const columns = held === null ? null : offeredColumns(parameter, held);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={`param-${parameter.name}`}>
        {parameter.name.replace(/_/g, " ")}
        {parameter.unit === "metres" && <span className={styles.unit}> (m)</span>}
        {parameter.unit === "minutes" && (
          <span className={styles.unit}> (min)</span>
        )}
      </label>
      <div className={styles.control}>
        {parameter.type === "string" && parameter.name === "sql" ? (
          <textarea
            id={`param-${parameter.name}`}
            className={styles.textarea}
            data-param={parameter.name}
            rows={5}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : parameter.type === "string" ? (
          <input
            id={`param-${parameter.name}`}
            className={styles.text}
            data-param={parameter.name}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : parameter.type === "number" ? (
          <NumberControl parameter={parameter} value={value} onChange={onChange} />
        ) : parameter.type === "number_list" ? (
          <NumberListControl
            parameter={parameter}
            value={value}
            onChange={onChange}
          />
        ) : parameter.type === "boolean" ? (
          // The shared switch (control): the input is real — Space,
          // focus, screen readers and the journeys' toBeChecked all keep
          // working.
          <Switch
            id={`param-${parameter.name}`}
            data-param={parameter.name}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
        ) : parameter.type === "enum" ? (
          <select
            id={`param-${parameter.name}`}
            className={styles.text}
            data-param={parameter.name}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            {(parameter.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : parameter.type === "enum_list" ? (
          <div className={styles.checks}>
            {(parameter.options ?? []).map((option) => {
              const chosen = Array.isArray(value) && value.includes(option);
              return (
                <label key={option} className={styles.checkbox}>
                  <input
                    type="checkbox"
                    data-param-option={`${parameter.name}:${option}`}
                    checked={chosen}
                    onChange={(e) => {
                      const list = Array.isArray(value) ? [...value] : [];
                      onChange(
                        e.target.checked
                          ? [...list, option]
                          : list.filter((v) => v !== option),
                      );
                    }}
                  />
                  <span>{option}</span>
                </label>
              );
            })}
          </div>
        ) : parameter.type === "column_list" ? (
          // **A list of columns is not a list of aggregates.** The carry
          // editor below builds `{aggregate, field}` entries; a grouping or a
          // plain carry wants names, and rendering one as the other sends a
          // shape the run refuses.
          <div className={styles.checks}>
            {(columns ?? []).length === 0 && (
              <p className={styles.help}>Choose an input first.</p>
            )}
            {(columns ?? []).map((column) => {
              const chosen = Array.isArray(value) && value.includes(column.name);
              return (
                <label key={column.name} className={styles.checkbox}>
                  <input
                    type="checkbox"
                    data-param-column={`${parameter.name}:${column.name}`}
                    checked={chosen}
                    onChange={(e) => {
                      const list = Array.isArray(value) ? [...value] : [];
                      onChange(
                        e.target.checked
                          ? [...list, column.name]
                          : list.filter((v) => v !== column.name),
                      );
                    }}
                  />
                  <span>{column.name}</span>
                </label>
              );
            })}
          </div>
        ) : parameter.type === "field" ? (
          <select
            id={`param-${parameter.name}`}
            className={styles.text}
            data-param={parameter.name}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Choose a column…</option>
            {(columns ?? []).map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
        ) : (
          <CarriedValues
            value={Array.isArray(value) ? value : []}
            columns={columns}
            // The aggregates **this** parameter accepts, and whether it takes
            // a name of its own: a summary's aggregates are not the spatial
            // join's, and offering `any` or an alias there produces a request
            // the operation refuses or a name it ignores.
            aggregates={(parameter.options as Aggregate[] | undefined) ?? AGGREGATES}
            aliasable={parameter.aliasable !== false}
            onChange={onChange}
          />
        )}
        <p className={styles.help}>{helpLine(parameter.description)}</p>
      </div>
    </div>
  );
}

/**
 * A list of values to bring across, each an aggregate over the matched
 * features. `count` alone takes no column — it counts features rather than
 * values — so the column picker follows the aggregate rather than standing
 * beside it always enabled.
 */
function CarriedValues({
  value,
  columns,
  aggregates,
  aliasable,
  onChange,
}: {
  value: unknown[];
  columns: { name: string; type: string }[] | null;
  aggregates: Aggregate[];
  aliasable: boolean;
  onChange: (value: unknown) => void;
}) {
  const rows = value as { aggregate?: string; field?: string; as?: string }[];
  const update = (index: number, patch: Record<string, unknown>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className={styles.carry}>
      {rows.map((row, index) => (
        <div key={index} className={styles.carryRow}>
          <select
            className={styles.text}
            aria-label={`Aggregate ${index + 1}`}
            data-carry-aggregate={index}
            value={row.aggregate ?? "count"}
            onChange={(e) => {
              const aggregate = e.target.value;
              update(
                index,
                aggregate === "count"
                  ? { aggregate, field: undefined }
                  : { aggregate },
              );
            }}
          >
            {aggregates.map((aggregate) => (
              <option key={aggregate} value={aggregate}>
                {aggregate}
              </option>
            ))}
          </select>
          {row.aggregate !== "count" && row.aggregate !== undefined && (
            <select
              className={styles.text}
              aria-label={`Column ${index + 1}`}
              data-carry-field={index}
              value={row.field ?? ""}
              onChange={(e) => update(index, { field: e.target.value })}
            >
              <option value="">Choose a column…</option>
              {(columns ?? []).map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
          )}
          {/* **What to call it**, where the parameter says a value may be
              named. The join refuses a carried value whose derived name
              collides with a column the left input already has — two tables
              with a `name` column is the ordinary case — and tells the caller
              to choose another. A summary's aggregates take no alias, and
              offering one there would produce a name the operation ignores. */}
          {aliasable && (
          <input
            className={styles.text}
            aria-label={`Call value ${index + 1}`}
            data-carry-as={index}
            placeholder="call it…"
            value={row.as ?? ""}
            onChange={(e) =>
              update(index, { as: e.target.value === "" ? undefined : e.target.value })
            }
          />
          )}
          <button
            className={styles.dropRow}
            aria-label={`Remove value ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        className={styles.addRow}
        data-carry-add
        onClick={() => onChange([...rows, { aggregate: "count" }])}
      >
        Add a value
      </button>
    </div>
  );
}

/**
 * A number with a feel for it: the free box always
 * — every range here is honest about being open at the box — plus a
 * slider where one can mean something. A verb-declared bound gives a true
 * linear slider; a ground-metres distance gets a **log** slider over the
 * span real buffers live in (10 m – 25 km), because 200 m and 2 km should
 * not be two pixels apart. Typing past the span leaves the thumb pinned
 * and the value honest.
 */
const METRES_MIN = 10;
const METRES_MAX = 25_000;

function NumberControl({
  parameter,
  value,
  onChange,
}: {
  parameter: OperationParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const held = typeof value === "number" ? value : undefined;
  const bounded = parameter.min !== undefined && parameter.max !== undefined;
  const metric = parameter.unit === "metres";
  // The typed value is kept — a silent clamp would run something the user did not write — but the
  // range speaks at the field and the gate holds. The ground-metres floor and the catalog bounds
  // share one voice and one element — the gate refuses the same values (the floor once disabled Run
  // with no sentence rendered, a dead button with no why).
  const floored = metric && held !== undefined && held <= 0;
  const outside =
    bounded && held !== undefined && (held < parameter.min! || held > parameter.max!);
  // A ceiling standing alone: the metre parameters serve only `max`,
  // because their floor is exclusive zero. Same voice, same element.
  const over =
    !bounded &&
    parameter.max !== undefined &&
    held !== undefined &&
    held > parameter.max;
  const range =
    floored || outside || over ? (
      <p className={styles.problem} data-bounds-problem={parameter.name}>
        {floored
          ? `A ${parameter.name.replace(/_/g, " ")} is more than 0 metres.`
          : outside
            ? `A ${parameter.name.replace(/_/g, " ")} is ${parameter.min} to ${parameter.max}.`
            : ceilingSentence(parameter)}
      </p>
    ) : null;
  const box = (
    <input
      id={`param-${parameter.name}`}
      className={styles.number}
      data-param={parameter.name}
      type="number"
      min={parameter.min ?? (metric ? 0 : undefined)}
      step={metric ? "any" : undefined}
      // A metric box has no spinner and no arrow stepping:
      // native stepping cannot express "more than zero, fractions free" —
      // it either lands on 0 or forbids 0.5. The slider is the stepping
      // affordance; the box is for the exact value.
      data-metric={metric || undefined}
      onKeyDown={
        metric
          ? (e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
            }
          : undefined
      }
      max={parameter.max}
      value={held ?? ""}
      onChange={(e) =>
        // A number parameter that arrived as a string becomes a malformed
        // request the run refuses; the empty field is absent, not zero.
        onChange(e.target.value === "" ? undefined : Number(e.target.value))
      }
    />
  );
  if (!bounded && !metric)
    return (
      <>
        {box}
        {range}
      </>
    );

  const toSlider = (v: number) =>
    metric
      ? Math.round(
          (100 * (Math.log(Math.max(METRES_MIN, Math.min(METRES_MAX, v))) - Math.log(METRES_MIN))) /
            (Math.log(METRES_MAX) - Math.log(METRES_MIN)),
        )
      : v;
  const fromSlider = (raw: number) => {
    if (!metric) return raw;
    const exact = Math.exp(
      Math.log(METRES_MIN) + (raw / 100) * (Math.log(METRES_MAX) - Math.log(METRES_MIN)),
    );
    // Two figures of a round number, not seven digits of a logarithm.
    const scale = 10 ** Math.max(0, Math.floor(Math.log10(exact)) - 1);
    return Math.round(exact / scale) * scale;
  };

  return (
    <>
      <div className={styles.numberRow}>
        <input
          type="range"
          className={styles.slider}
          aria-label={`${parameter.name.replace(/_/g, " ")} slider`}
          data-param-slider={parameter.name}
          min={metric ? 0 : parameter.min}
          max={metric ? 100 : parameter.max}
          step={1}
          value={held !== undefined ? toSlider(held) : metric ? 0 : (parameter.min ?? 0)}
          // The log slider's native value is a 0–100 coordinate; assistive
          // technology announces the distance it stands for.
          aria-valuetext={
            metric ? `${held ?? METRES_MIN} metres` : undefined
          }
          onChange={(e) => onChange(fromSlider(Number(e.target.value)))}
        />
        {box}
      </div>
      {range}
    </>
  );
}

/**
 * A list of plain numbers: the specimen's fixed row of boxes, one per
 * possible item, an empty box simply an unasked value. The array the form
 * holds is the non-empty boxes in order; every refusal — fractions,
 * duplicates, the floor — is the catalog's own served rule, said by the
 * form's standing bounds machinery rather than by anything verb-specific.
 */
function NumberListControl({
  parameter,
  value,
  onChange,
}: {
  parameter: OperationParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const held = Array.isArray(value) ? (value as number[]) : [];
  const slots = parameter.maxItems ?? 4;
  // A pristine form is asked, not scolded — the empty-list sentence waits for the field to have
  // been touched; the gate holds either way.
  const [touched, setTouched] = useState(false);
  // The same sentence the gate refuses on (lesson: a disarmed Run with
  // no rendered why is a dead button).
  const problem =
    numberListProblem(parameter, held) ??
    (touched && parameter.required && held.length === 0
      ? emptyListSentence(parameter)
      : null);
  // The specimen's per-box cueing (the smoke caught it dropped): the box
  // holding the broken or repeated value is the one that says so.
  const floor = parameter.itemMin ?? 1;
  const offending = (index: number): boolean => {
    const item = held[index];
    if (item === undefined) return false;
    if (
      !Number.isFinite(item) ||
      (parameter.itemInteger === true && !Number.isInteger(item)) ||
      item < floor
    ) {
      return true;
    }
    return (
      parameter.itemsUnique === true && held.slice(0, index).includes(item)
    );
  };
  const set = (index: number, raw: string) => {
    setTouched(true);
    const next = [...held];
    if (raw === "") {
      next.splice(index, 1);
    } else {
      next[index] = Number(raw);
    }
    onChange(next.filter((item) => item !== undefined));
  };
  return (
    <>
      <div className={styles.numberList} data-param={parameter.name}>
        {Array.from({ length: slots }, (_, index) => (
          <input
            key={index}
            type="number"
            className={styles.number}
            data-param-item={`${parameter.name}-${index}`}
            data-item-problem={offending(index) || undefined}
            min={parameter.itemMin}
            step={parameter.itemInteger ? 1 : "any"}
            placeholder="—"
            value={held[index] ?? ""}
            onChange={(e) => set(index, e.target.value)}
          />
        ))}
      </div>
      {problem && (
        <p className={styles.problem} data-bounds-problem={parameter.name}>
          {problem}
        </p>
      )}
    </>
  );
}
