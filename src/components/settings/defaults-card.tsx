"use client";
import { useRef, type ReactNode } from "react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { choiceValues, choiceWords, DEFAULTS_LABELS, type DefaultsCard, type DefaultsRow } from "./defaults-table";
import { keptValues, writeInstanceSettings, type InstanceRead } from "./instance-read";
import { inLabels } from "./limits-table";
import { SaveUnit, type UnitSnapshot, type Value } from "./save-unit";
import { unitControlFor, type ReadSetting } from "./server-set";
import { NumberField, RowError, Rows, SegmentChoice, SettingRow } from "./SettingRows";
import { Note, ResetSlot, SavedMark, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";

/**
 * A card of what new things start with, shared by the Maps, Workflows &
 * SQL and Publishing tabs: one save unit over the instance write, its
 * rows from the defaults' table, each value kept as it changes, the
 * card's Reset to the read's defaults and its Undo, and a refusal naming
 * no row as the card's note in the rows' words. What each row draws is
 * its tab's.
 */

type Settings = InstanceRead["settings"];

/** The card's settings the read carries, in the order its rows show them. */
function cardKeys(card: DefaultsCard, settings: Settings): string[] {
  return card.rows.flatMap(row => row.fields.map(field => field.key)).filter(key => settings[key]);
}

/** The row each setting shares its Saved with, where a row holds several
 * (the starting view's three numbers, the three opacities). */
function sharedRows(card: DefaultsCard): ReadonlyMap<string, string> {
  return new Map(card.rows.filter(row => row.fields.length > 1).flatMap(row => row.fields.map(field => [field.key, row.id] as const)));
}

function defaultsUnit(card: DefaultsCard, settings: Settings): SaveUnit {
  const keys = cardKeys(card, settings), rows = sharedRows(card);
  return new SaveUnit({
    title: card.title,
    controls: keys.map(key => ({ ...unitControlFor(settings[key]), ...(rows.has(key) ? { row: rows.get(key) } : {}) })),
    kept: Object.fromEntries(keys.map(key => [key, settings[key].value as Value])),
    write: async patch => keptValues(await writeInstanceSettings(patch), keys),
  });
}

/** A card's save unit, made once for the card's life from the read. */
export function useDefaultsUnit(card: DefaultsCard, settings: Settings): [SaveUnit, UnitSnapshot] {
  return useSaveUnit(card.id, () => defaultsUnit(card, settings));
}

/** The card: its title, Reset then Undo, anything else its head shows, the
 * quiet line under its title (or a drawing in its place), its rows, and
 * its note. */
export function DefaultsCardView({ card, unit, snapshot, head, lead, children }: {
  card: DefaultsCard;
  unit: SaveUnit;
  snapshot: UnitSnapshot;
  /** Shown at the head's right, after Reset or Undo. */
  head?: ReactNode;
  /** Drawn under the title in place of the card's quiet line. */
  lead?: ReactNode;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  useUnitFocus(root, snapshot.focus);
  return <SettingsCard ref={root} id={card.id} title={card.title} headingId={`${card.id}-heading`}
    head={<><ResetSlot unit={unit} card={snapshot} />{head}</>}>
    {lead ?? (card.lead ? <Note>{card.lead}</Note> : null)}
    <Rows>{children}</Rows>
    {snapshot.note && <ErrorNote message={inLabels(snapshot.note.message, DEFAULTS_LABELS)}
      onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
  </SettingsCard>;
}

/** Whether a row shows Saved: any of its settings was just kept. */
export function rowSaved(row: DefaultsRow, snapshot: UnitSnapshot): boolean {
  return row.fields.some(field => snapshot.saved.includes(field.key));
}

/** Where a row's red line is, for the field it names. */
export const errorId = (row: DefaultsRow, index: number) => row.fields.length > 1 ? `${row.id}-error-${index}` : `${row.id}-error`;

/** The red lines under a row: one per setting the card's check or the
 * server refused, named by its own label where the row holds several. */
export function RowErrors({ row, snapshot }: { row: DefaultsRow; snapshot: UnitSnapshot }) {
  return <>{row.fields.map((field, index) => {
    const error = snapshot.errors[field.key];
    return error ? <RowError key={field.key} id={errorId(row, index)}>{field.label ? `${field.label}: ${error}` : error}</RowError> : null;
  })}</>;
}

/** The attributes a control takes while its row's red line names it. */
export function invalid(row: DefaultsRow, index: number, snapshot: UnitSnapshot) {
  return snapshot.errors[row.fields[index].key] ? { "aria-invalid": true, "aria-describedby": errorId(row, index) } : {};
}

/** A number of the card's, within the read's range: kept at once when
 * stepped, on Enter or leaving when typed. */
export function DefaultsNumber({ row, index, setting, unit, snapshot, name, prefix }: {
  row: DefaultsRow;
  /** Which of the row's settings it is. */
  index: number;
  setting: ReadSetting;
  unit: SaveUnit;
  snapshot: UnitSnapshot;
  /** Its accessible name. */
  name: string;
  /** Its own name, shown before it. */
  prefix?: string;
}) {
  const field = row.fields[index], write = setting.write;
  const range = write?.kind === "integer" || write?.kind === "decimal" ? write : null;
  return <NumberField label={name} unitKey={field.key} value={String(snapshot.values[field.key] ?? "")} prefix={prefix}
    unit={field.unit} step={field.step} min={range?.min} max={range?.max}
    error={snapshot.errors[field.key]} errorId={errorId(row, index)}
    onStep={text => unit.step(field.key, text)} onType={text => unit.edit(field.key, text)} onCommit={() => unit.commit(field.key)} />;
}

/** A number as the server reports it kept, or the setting's default where
 * it reports none. What a sample or the locator draws: never a number
 * still being typed, nor one the server refused. */
export function keptNumber(snapshot: UnitSnapshot, setting: ReadSetting | undefined, key: string): number {
  const kept = snapshot.kept[key], value = Number(kept);
  return kept !== null && kept !== undefined && Number.isFinite(value) ? value : Number(setting?.defaultValue);
}

/** A row whose one setting is a choice: the values the read offers as
 * segments in their words, kept at once, Saved after them. */
export function DefaultsChoiceRow({ row, setting, unit, snapshot }: {
  row: DefaultsRow;
  setting: ReadSetting | undefined;
  unit: SaveUnit;
  snapshot: UnitSnapshot;
}) {
  const key = row.fields[0].key;
  return <SettingRow id={row.id} label={row.label} meta={row.meta}>
    <SegmentChoice label={row.label} value={String(snapshot.values[key] ?? "")}
      choices={choiceValues(setting).map(value => ({ value, label: choiceWords(key, value) }))}
      onChange={next => unit.choose(key, next)} />
    {rowSaved(row, snapshot) && <SavedMark />}
    <RowErrors row={row} snapshot={snapshot} />
  </SettingRow>;
}
