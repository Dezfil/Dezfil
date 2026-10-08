"use client";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Switch } from "@/components/ui/Switch";
import { DefaultsCardView, DefaultsChoiceRow, invalid, RowErrors, rowSaved, useDefaultsUnit } from "./defaults-card";
import { choiceValues, choiceWords, DEFAULTS_TABS } from "./defaults-table";
import { useInstanceRead, type InstanceRead } from "./instance-read";
import { PictureChoice } from "./PictureChoice";
import type { SaveUnit, UnitSnapshot } from "./save-unit";
import { useDrawn } from "./settings-land";
import { SettingRow } from "./SettingRows";
import { SavedMark } from "./SettingsCard";
import cardStyles from "./SettingsCard.module.css";
import styles from "./WorkflowsTab.module.css";

type Settings = InstanceRead["settings"];
const [CANVAS, CONSOLE] = DEFAULTS_TABS.workflows;

/** Workflows & SQL: what the workflow canvas and the SQL console open
 * with, as the configuration read reports it. Every row is a choice or a
 * switch, kept as it changes; the editor sample follows what is kept. */
export function WorkflowsTab() {
  const { read, error, retry } = useInstanceRead();
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <WorkflowsCards settings={read.settings} />;
}

function WorkflowsCards({ settings }: { settings: Settings }) {
  const [canvasUnit, canvas] = useDefaultsUnit(CANVAS, settings);
  const [sqlUnit, sql] = useDefaultsUnit(CONSOLE, settings);
  return <>
    <CanvasCard unit={canvasUnit} snapshot={canvas} settings={settings} />
    <ConsoleCard unit={sqlUnit} snapshot={sql} settings={settings} />
  </>;
}

interface CardProps { unit: SaveUnit; snapshot: UnitSnapshot; settings: Settings }

function CanvasCard({ unit, snapshot, settings }: CardProps) {
  const [opens, minimap, band] = CANVAS.rows;
  return <DefaultsCardView card={CANVAS} unit={unit} snapshot={snapshot}>
    <SettingRow id={opens.id} label={opens.label} mark={rowSaved(opens, snapshot) ? <SavedMark /> : null}>
      <PictureChoice label={opens.label} size="m" value={String(snapshot.values["canvas.opens"] ?? "")}
        choices={choiceValues(settings["canvas.opens"]).map(value => ({ value, label: choiceWords("canvas.opens", value), picture: <CanvasPicture opens={value} /> }))}
        onChange={next => unit.choose("canvas.opens", next)} />
      <RowErrors row={opens} snapshot={snapshot} />
    </SettingRow>
    {[minimap, band].map(row => <DefaultsChoiceRow key={row.id} row={row} setting={settings[row.fields[0].key]} unit={unit} snapshot={snapshot} />)}
  </DefaultsCardView>;
}

function ConsoleCard({ unit, snapshot, settings }: CardProps) {
  const [size, wrap] = CONSOLE.rows;
  const kept = Number(snapshot.kept["sqlConsole.textSize"] ?? settings["sqlConsole.textSize"]?.defaultValue);
  return <DefaultsCardView card={CONSOLE} unit={unit} snapshot={snapshot}
    lead={<EditorSample size={Number.isFinite(kept) ? kept : 12} wrap={snapshot.kept["sqlConsole.lineWrap"] === true} />}>
    <DefaultsChoiceRow row={size} setting={settings["sqlConsole.textSize"]} unit={unit} snapshot={snapshot} />
    <SettingRow id={wrap.id} label={wrap.label}>
      <Switch aria-label={wrap.label} data-unit-key="sqlConsole.lineWrap" checked={snapshot.values["sqlConsole.lineWrap"] === true}
        {...invalid(wrap, 0, snapshot)} onChange={event => unit.choose("sqlConsole.lineWrap", event.target.checked)} />
      {rowSaved(wrap, snapshot) && <SavedMark />}
      <RowErrors row={wrap} snapshot={snapshot} />
    </SettingRow>
  </DefaultsCardView>;
}

/** How a canvas opens, sketched in the interface's own tones: filling the
 * screen under its results band, or framed in the page. */
function CanvasPicture({ opens }: { opens: string }) {
  const nodes = <>
    <rect className={styles.node} x="34" y="26" width="16" height="10" rx="2.5" />
    <rect className={styles.node} x="62" y="20" width="16" height="10" rx="2.5" />
    <rect className={styles.node} x="62" y="38" width="16" height="10" rx="2.5" />
    <path className={styles.edge} d="M50 31h6c3 0 3-6 6-6M50 31h6c3 0 3 12 6 12" />
  </>;
  return <svg className={styles.picture} viewBox="0 0 112 70" data-canvas-picture={opens} aria-hidden="true">
    {opens === "framed" ? <>
      <rect className={styles.ground} width="112" height="70" />
      <rect className={styles.chromeQuiet} x="6" y="5" width="30" height="5" rx="2.5" />
      <rect className={styles.frame} x="6" y="14" width="100" height="38" rx="5" />
      <g transform="translate(-2 -3)">{nodes}</g>
      <rect className={styles.band} x="6" y="56" width="100" height="9" rx="3" />
    </> : <>
      <rect className={styles.canvas} width="112" height="70" />
      {nodes}
      <rect className={styles.chrome} x="6" y="5" width="30" height="5" rx="2.5" />
      <rect className={styles.band} x="6" y="56" width="100" height="9" rx="3" />
    </>}
  </svg>;
}

type Token = "keyword" | "function" | "string" | "number" | "comment" | "operator" | "text";

/** The query the sample shows, line by line, as the editor colors it. */
const QUERY: readonly (readonly (readonly [Token, string])[])[] = [
  [["comment", "-- Stations within 500 m of a 2026 flood zone"]],
  [["keyword", "SELECT"], ["text", " s.name, s.capacity, "], ["function", "ST_Distance"], ["operator", "("], ["text", "s.geom, f.geom"],
    ["operator", ")"], ["text", " "], ["keyword", "AS"], ["text", " metres"]],
  [["keyword", "FROM"], ["text", " stations s "], ["keyword", "JOIN"], ["text", " flood_zones_2026 f "], ["keyword", "ON"], ["text", " "],
    ["function", "ST_DWithin"], ["operator", "("], ["text", "s.geom, f.geom, "], ["number", "500"], ["operator", ")"]],
  [["keyword", "WHERE"], ["text", " s.status "], ["operator", "="], ["text", " "], ["string", "'active'"]],
  [["keyword", "ORDER BY"], ["text", " metres"], ["operator", ";"]],
];

/** The SQL console's editor in miniature: a query drawn as the editor
 * draws it, in its face, line height, gutter and code colors, at the
 * kept text size, its long lines wrapped while the kept wrap is on. Text,
 * not an editor. */
function EditorSample({ size, wrap }: { size: number; wrap: boolean }) {
  return <div className={styles.editor} data-editor-sample="" data-wrap={wrap || undefined} aria-hidden="true" style={{ fontSize: `${size}px` }}>
    {QUERY.map((line, index) => <div key={index} className={styles.line} data-line="">
      <span className={styles.gutter} data-gutter="">{index + 1}</span>
      <span className={styles.code} data-code="">
        {line.map(([token, text], at) => <span key={at} data-token={token === "text" ? undefined : token}>{text}</span>)}
      </span>
    </div>)}
  </div>;
}
