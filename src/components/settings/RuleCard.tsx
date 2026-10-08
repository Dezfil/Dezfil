"use client";
import { useId, useRef } from "react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Select, Textarea } from "@/components/ui/Field";
import { writeInstanceSettings, type InstanceRead } from "./instance-read";
import { useLiveValue } from "./live-values";
import { SaveUnit, type UnitControl, type UnitSnapshot, type Value } from "./save-unit";
import { ruleChoiceWords, ruleRefusalWords, sitesList, sitesText, type RuleCard, type RuleField, type RuleRow } from "./security-table";
import { serverSetState, unitControlFor, type ReadSetting } from "./server-set";
import { LockedField, NumberField, RowError, Rows, SegmentChoice, SettingRow } from "./SettingRows";
import { cardFormClass, ResetSlot, SavedMark, SaveLine, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import styles from "./RuleCard.module.css";

/**
 * A card of the Security tab, or Publishing's Public links card: one save
 * unit over the instance write, its rows from the table, each choice kept
 * as it is made, each count kept when stepped or when typed on Enter or
 * leaving, the listed sites typed and kept on the card's Save (blank lines
 * dropped, sent as a list), Saved only after the server accepted, the
 * refusals as the red line under their row, and Reset to the read's
 * defaults, the listed sites cleared with the rest, then Undo. Listed
 * sites chosen while none is listed waits for the sites and goes with
 * them.
 */

type Settings = InstanceRead["settings"];

const SITES = "publishing.embedSites";
const EMBEDDING = "publishing.embedding";
const NONE_LISTED = "Add at least one site, or choose Any site.";

/** The card's settings the read carries, in the order its rows show them. */
function cardKeys(card: RuleCard, settings: Settings): string[] {
  return card.rows.flatMap(row => row.fields.map(field => field.key)).filter(key => settings[key]);
}

/** What a setting shows in its control: the listed sites as lines. */
const shown = (key: string, value: unknown): Value => key === SITES ? sitesText(value) : value as Value;

/** The save unit's view of a setting. The listed sites reset with the rest
 * of the card: their default, no site, in the lines the field shows. */
function control(key: string, settings: Settings, row: string | undefined): UnitControl {
  const base = { ...unitControlFor(settings[key]), ...(row ? { row } : {}) };
  return key === SITES && !base.locked ? { ...base, defaultValue: shown(key, settings[key].defaultValue) } : base;
}

function ruleUnit(card: RuleCard, settings: Settings): SaveUnit {
  const keys = cardKeys(card, settings);
  const rows = new Map(card.rows.filter(row => row.fields.length > 1).flatMap(row => row.fields.map(field => [field.key as string, row.id] as const)));
  const sites = keys.includes(SITES);
  return new SaveUnit({
    title: card.title,
    controls: keys.map(key => control(key, settings, rows.get(key))),
    kept: Object.fromEntries(keys.map(key => [key, shown(key, settings[key].value)])),
    write: async patch => {
      // Lines go as a list; Reset's null clears the list as it clears the choices.
      const request = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, key === SITES && value !== null ? sitesList(value) : value]));
      const answer = await writeInstanceSettings(request);
      return Object.fromEntries(keys.filter(key => key in answer.settings).map(key => [key, shown(key, answer.settings[key].value)]));
    },
    // Listed sites with none listed: the card's own check, before any request.
    ...(sites ? { validate: values => values[EMBEDDING] === "listed" && !sitesList(values[SITES]).length ? { [SITES]: NONE_LISTED } : null } : {}),
  });
}

/** The card: its title, Reset then Undo, its rows, its note, and the Save
 * line while the listed sites wait. */
export function RuleCardView({ card, settings }: { card: RuleCard; settings: Settings }) {
  const root = useRef<HTMLElement>(null);
  const [unit, snapshot] = useSaveUnit(card.id, () => ruleUnit(card, settings));
  useUnitFocus(root, snapshot.focus);
  const typed = cardKeys(card, settings).includes(SITES);
  const rows = <Rows>{card.rows.map(row => <RuleRowView key={row.id} row={row} settings={settings} unit={unit} snapshot={snapshot} />)}</Rows>;
  return <SettingsCard ref={root} id={card.id} title={card.title} headingId={`${card.id}-heading`} head={<ResetSlot unit={unit} card={snapshot} />}>
    {typed ? <form className={cardFormClass} noValidate onSubmit={event => { event.preventDefault(); unit.save(); }}>
      {rows}
      {snapshot.note && <ErrorNote message={ruleRefusalWords(snapshot.note.message).text} onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
      {snapshot.saveLine && <SaveLine busy={snapshot.busy} onCancel={() => unit.cancel()} />}
    </form> : <>
      {rows}
      {snapshot.note && <ErrorNote message={ruleRefusalWords(snapshot.note.message).text} onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
    </>}
  </SettingsCard>;
}

const errorId = (row: RuleRow, index: number) => row.fields.length > 1 ? `${row.id}-error-${index}` : `${row.id}-error`;

/** The attributes a control takes while its row's red line names it. */
function invalid(row: RuleRow, index: number, snapshot: UnitSnapshot) {
  return snapshot.errors[row.fields[index].key] ? { "aria-invalid": true, "aria-describedby": errorId(row, index) } : {};
}

/** The red lines under a row, in the page's words: one per setting refused,
 * named by its own name where the row draws several counts, except a
 * refusal of the two that only hold together, which names both. */
function RowErrors({ row, snapshot }: { row: RuleRow; snapshot: UnitSnapshot }) {
  const shownOnce = new Set<string>();
  return <>{row.fields.map((field, index) => {
    const error = snapshot.errors[field.key];
    if (!error) return null;
    const words = ruleRefusalWords(error);
    if (shownOnce.has(words.text)) return null;
    shownOnce.add(words.text);
    const named = row.draw === "numbers" && field.label && !words.together;
    return <RowError key={field.key} id={errorId(row, index)}>{named ? `${field.label}: ${words.text}` : words.text}</RowError>;
  })}</>;
}

function Notes({ row, value }: { row: RuleRow; value: unknown }) {
  return <>{(row.notes ?? []).filter(note => note.when(value)).map(note => <p key={note.text} className={styles.under}>{note.text}</p>)}</>;
}

/** The values a choice offers, as the read gives them, in their words. */
function choices(setting: ReadSetting, key: string) {
  return (setting.write?.kind === "choice" ? setting.write.values : []).map(value => ({ value, label: ruleChoiceWords(key, value) }));
}

function RuleRowView({ row, settings, unit, snapshot }: { row: RuleRow; settings: Settings; unit: SaveUnit; snapshot: UnitSnapshot }) {
  const [first] = row.fields;
  const setting = settings[first.key];
  if (!setting) return null;
  const decided = serverSetState(setting);
  if (decided) {
    const value = row.draw === "numbers" ? `${setting.value ?? ""}${first.unit ? ` ${first.unit}` : ""}` : ruleChoiceWords(first.key, setting.value);
    return <SettingRow id={row.id} label={row.label} meta={row.meta}>
      <LockedField label={row.label} value={value} state={decided} width="m" />
    </SettingRow>;
  }
  if (row.draw === "sites") return <SitesRow row={row} settings={settings} unit={unit} snapshot={snapshot} />;
  const saved = row.fields.some(field => snapshot.saved.includes(field.key)) && <SavedMark />;
  const value = String(snapshot.values[first.key] ?? "");
  return <SettingRow id={row.id} label={row.label} meta={row.meta}>
    {row.draw === "select" && <Select className={styles.select} aria-label={row.label} data-unit-key={first.key} value={value}
      {...invalid(row, 0, snapshot)} onChange={event => unit.choose(first.key, event.target.value)}>
      {choices(setting, first.key).map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </Select>}
    {row.draw === "segments" && <SegmentChoice label={row.label} value={value} choices={choices(setting, first.key)} onChange={next => unit.choose(first.key, next)} />}
    {row.draw === "numbers" && row.fields.map((field, index) => <Count key={field.key} row={row} field={field} index={index}
      setting={settings[field.key]} unit={unit} snapshot={snapshot} />)}
    {row.after && <span className={styles.after}>{row.after}</span>}
    {saved}
    <RowErrors row={row} snapshot={snapshot} />
    <Notes row={row} value={snapshot.values[first.key]} />
  </SettingRow>;
}

/** A count within the read's range: kept at once when stepped, on Enter or
 * leaving when typed. */
function Count({ row, field, index, setting, unit, snapshot }: {
  row: RuleRow; field: RuleField; index: number; setting: ReadSetting | undefined; unit: SaveUnit; snapshot: UnitSnapshot;
}) {
  if (!setting) return null;
  const range = setting.write?.kind === "integer" ? setting.write : null;
  const error = snapshot.errors[field.key];
  return <NumberField label={field.name ?? row.label} unitKey={field.key} value={String(snapshot.values[field.key] ?? "")} unit={field.unit}
    min={range?.min} max={range?.max} error={error ? ruleRefusalWords(error).text : null} errorId={errorId(row, index)}
    onStep={text => unit.step(field.key, text)} onType={text => unit.edit(field.key, text)} onCommit={() => unit.commit(field.key)} />;
}

/** Embedding on other sites: the choice, kept at once, except Listed sites
 * chosen while none is listed, which waits for the sites; under Listed
 * sites (or while typed sites wait) the list, one site per line, kept on
 * the card's Save; under Off its line. */
function SitesRow({ row, settings, unit, snapshot }: { row: RuleRow; settings: Settings; unit: SaveUnit; snapshot: UnitSnapshot }) {
  const id = useId();
  const choice = snapshot.values[EMBEDDING], text = String(snapshot.values[SITES] ?? "");
  const waiting = text !== String(snapshot.kept[SITES] ?? "");
  const listed = choice === "listed";
  const words = ruleChoiceWords(EMBEDDING, choice);
  useLiveValue(row.id, listed && sitesList(text).length ? `${words}: ${sitesList(text).join(", ")}` : words);
  const sites = row.fields.findIndex(field => field.key === SITES), field = row.fields[sites];
  const saved = row.fields.some(each => snapshot.saved.includes(each.key)) && <SavedMark />;
  return <SettingRow id={row.id} label={row.label} meta={row.meta}>
    <SegmentChoice label={row.label} value={String(choice ?? "")} choices={choices(settings[EMBEDDING], EMBEDDING)}
      onChange={next => next === "listed" && !sitesList(snapshot.kept[SITES]).length ? unit.hold(EMBEDDING, next) : unit.choose(EMBEDDING, next)} />
    {saved}
    {(listed || waiting) && settings[SITES] && <Textarea id={`${id}-sites`} className={styles.sites} aria-label={field.name} data-unit-key={SITES}
      rows={3} placeholder="https://www.stadtwerke.example" spellCheck={false} value={text} disabled={snapshot.busy}
      {...invalid(row, sites, snapshot)} onChange={event => unit.edit(SITES, event.target.value)} />}
    <RowErrors row={row} snapshot={snapshot} />
    <Notes row={row} value={choice} />
  </SettingRow>;
}
