"use client";
import { useRef, useState } from "react";
import type { ProviderCache } from "@/lib/provider-caches";
import { ErrorNote } from "@/components/ui/ErrorNote";
import {
  cardSetUp, DATA_LABELS, dataTabCards, governedNote, isTemplatesCard, lockedLines, numberWords, pageRange, toApi, toPage,
  type DataCard, type DataRow, type LockedRow, type NumberRow,
} from "./data-table";
import { useInstanceRead, writeInstanceSettings, type InstanceRead, type ServicesRead } from "./instance-read";
import { inLabels } from "./limits-table";
import { RuleCardView } from "./RuleCard";
import { SaveUnit, type UnitControl, type UnitSnapshot } from "./save-unit";
import { CONNECTIONS_CARD } from "./security-table";
import { TemplatesCard } from "./TemplatesCard";
import { serverSetState, unitControlFor, type ReadSetting } from "./server-set";
import { ServiceAddressRow } from "./ServiceAddressRow";
import { CacheRowView, ReleasesRowView, ServiceTest } from "./ServiceChecks";
import { useDrawn } from "./settings-land";
import { LockedField, NumberField, RowError, Rows, SettingRow } from "./SettingRows";
import { ResetSlot, SavedMark, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import cardStyles from "./SettingsCard.module.css";
import styles from "./DataTab.module.css";

type Settings = InstanceRead["settings"];

/** Data & services: the address finder, travel time, OpenStreetMap,
 * Overture, cloud storage, the template catalogue, the private hosts the
 * server may reach, and who may add connections or import from links, as
 * the configuration read reports them. A service card's numbers are one
 * save unit, kept as they change and shown in the page's units; its
 * address is its own form, kept on Save; its Test and its cache answer at
 * once. What the server's environment decides is drawn locked with its
 * variable. */
export function DataTab() {
  const { read, error, retry } = useInstanceRead();
  const [answered, setAnswered] = useState<InstanceRead | null>(null);
  const [kept, setKept] = useState<ServicesRead | null>(null);
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  const now = answered ?? read;
  const services = kept ?? now.services;
  const onAnswer = (answer: InstanceRead) => { setAnswered(answer); if (answer.services) setKept(answer.services); };
  // What a Clear or Check now changed, over what the server last reported.
  const change = (next: (base: ServicesRead) => ServicesRead) => setKept(current => {
    const base = current ?? services;
    return base ? next(base) : null;
  });
  const onCleared = (cache: ProviderCache) => change(base => ({ ...base, [cache]: { ...base[cache], bytes: 0, answers: 0 } }));
  const onListed = (releases: number, newest: string) =>
    change(base => ({ ...base, overture: { listed: true, releases, newest, listedAt: new Date().toISOString() } }));
  return <>
    {dataTabCards().map(card => isTemplatesCard(card)
      ? <TemplatesCard key={card.id} read={read} now={now} onAnswer={onAnswer} />
      : <ServiceCardView key={card.id} card={card} read={read} now={now} services={services}
        onAnswer={onAnswer} onCleared={onCleared} onListed={onListed} />)}
    <RuleCardView card={CONNECTIONS_CARD} settings={read.settings} />
  </>;
}

/** The save unit's view of a number: the page's range, places and default. */
function pageControl(row: NumberRow, setting: ReadSetting): UnitControl {
  const base = unitControlFor(setting);
  return { ...base, ...pageRange(row, setting.write), decimal: row.places > 0, places: row.places,
    ...(base.defaultValue !== undefined ? { defaultValue: toPage(row, base.defaultValue) } : {}) };
}

/** A card's numbers as one save unit in the page's units: each write sends
 * the variable's unit, and what the response reports comes back in the page's. */
function serviceUnit(card: DataCard, settings: Settings, onAnswer: (read: InstanceRead) => void): SaveUnit {
  const rows = card.rows.filter((row): row is NumberRow => row.kind === "number" && !!settings[row.key]);
  const byKey = new Map<string, NumberRow>(rows.map(row => [row.key, row]));
  const shown = (read: InstanceRead) => Object.fromEntries(rows.filter(row => row.key in read.settings)
    .map(row => [row.key, toPage(row, read.settings[row.key].value)]));
  return new SaveUnit({
    title: card.title,
    controls: rows.map(row => pageControl(row, settings[row.key])),
    kept: Object.fromEntries(rows.map(row => [row.key, toPage(row, settings[row.key].value)])),
    write: async patch => {
      const request = Object.fromEntries(Object.entries(patch).map(([key, value]) =>
        [key, value === null ? null : toApi(byKey.get(key)!, Number(value))]));
      const answer = await writeInstanceSettings(request);
      onAnswer(answer);
      return shown(answer);
    },
  });
}

function ServiceCardView({ card, read, now, services, onAnswer, onCleared, onListed }: {
  card: DataCard;
  /** The read the card's numbers start from. */
  read: InstanceRead;
  /** The latest the server reported: the read, or a write's response. */
  now: InstanceRead;
  services: ServicesRead | undefined;
  onAnswer: (read: InstanceRead) => void;
  onCleared: (cache: ProviderCache) => void;
  onListed: (releases: number, newest: string) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [unit, snapshot] = useSaveUnit(card.id, () => serviceUnit(card, read.settings, onAnswer));
  useUnitFocus(root, snapshot.focus);
  // Without its address the service is Not set up: its address row alone.
  const setUp = cardSetUp(card, now.settings);
  const rows = setUp ? card.rows : card.rows.filter(row => row.kind === "address");
  const end = setUp ? card.test && <ServiceTest service={card.test} /> : <span className={styles.chip}>Not set up</span>;
  const head = <>{setUp && <ResetSlot unit={unit} card={snapshot} />}{end && <span className={styles.headEnd}>{end}</span>}</>;
  const view = (row: DataRow) => {
    switch (row.kind) {
      case "address": return <ServiceAddressRow key={row.id} row={row} setting={now.settings[row.key]} card={card.title} onAnswer={onAnswer} />;
      case "number": return <NumberRowView key={row.id} row={row} setting={now.settings[row.key]} unit={unit} snapshot={snapshot} />;
      case "cache": return <CacheRowView key={row.id} row={row} facts={services?.[row.cache]} onCleared={onCleared} />;
      case "releases": return <ReleasesRowView key={row.id} row={row} facts={services?.overture} onListed={onListed} />;
      case "locked": return <LockedRowView key={row.id} row={row} setting={now.settings[row.key]} />;
    }
  };
  return <SettingsCard ref={root} id={card.id} title={card.title} headingId={`${card.id}-heading`} head={head}>
    <Rows>{rows.map(view)}</Rows>
    {snapshot.note && <ErrorNote message={inLabels(snapshot.note.message, DATA_LABELS)}
      onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
  </SettingsCard>;
}

/** A number in the page's unit: kept at once when stepped, on Enter or
 * leaving when typed; locked with its variable when the environment sets it. */
function NumberRowView({ row, setting, unit, snapshot }: { row: NumberRow; setting: ReadSetting | undefined; unit: SaveUnit; snapshot: UnitSnapshot }) {
  if (!setting) return null;
  const decided = serverSetState(setting);
  if (decided) {
    return <SettingRow id={row.id} label={row.label}>
      <LockedField label={row.label} value={numberWords(row, setting.value)} state={decided} width="m" />
    </SettingRow>;
  }
  const range = pageRange(row, setting.write);
  const error = snapshot.errors[row.key], errorId = `${row.id}-error`;
  return <SettingRow id={row.id} label={row.label}>
    <NumberField label={row.label} unitKey={row.key} value={String(snapshot.values[row.key] ?? "")} unit={row.unit}
      min={range.min} max={range.max} step={row.places ? 10 ** -row.places : 1} error={error} errorId={errorId}
      onStep={text => unit.step(row.key, text)} onType={text => unit.edit(row.key, text)} onCommit={() => unit.commit(row.key)} />
    {snapshot.saved.includes(row.key) && <SavedMark />}
    {error && <RowError id={errorId}>{inLabels(error, DATA_LABELS)}</RowError>}
  </SettingRow>;
}

/** A value only the server's environment sets: the credentials switch On
 * or Off, or the hosts the server may reach one per line (None without
 * any), with the note naming what the egress check governs. */
function LockedRowView({ row, setting }: { row: LockedRow; setting: ReadSetting | undefined }) {
  if (!setting) return null;
  const state = serverSetState(setting) ?? { kind: "fixed" as const, variable: setting.environment ?? null };
  const lines = lockedLines(row, setting.value);
  if (row.key === "objectStoreCredentials") {
    return <SettingRow id={row.id} label={row.label} meta={row.meta}>
      <LockedField label={row.label} value={lines[0]} state={state} width="s" />
    </SettingRow>;
  }
  return <SettingRow id={row.id} label={row.label} meta={row.meta} stack>
    <LockedField label={row.label} value="None" lines={lines} mono={lines.length > 0} state={state} />
    <p className={styles.under}>{governedNote()}</p>
  </SettingRow>;
}
