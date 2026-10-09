"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { dataRowAddress } from "./data-table";
import { keptValues, useInstanceRead, writeInstanceSettings, type InstanceRead } from "./instance-read";
import { capacityText, inLabels, LIMITS_CARDS, LIMITS_LABELS, serviceSetUp, shownUnit, withShownUnit, type LimitsCard, type LimitsRow } from "./limits-table";
import { SaveUnit, type UnitSnapshot, type Value } from "./save-unit";
import { useDrawn } from "./settings-land";
import { formatSettingNumber, serverSetState, unitControlFor } from "./server-set";
import { LockedField, NumberField, RowError, Rows, SettingRow, ValueText } from "./SettingRows";
import { ResetSlot, SavedMark, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import styles from "./SettingsCard.module.css";

type Settings = InstanceRead["settings"];

/** The words a refusal is shown in: a setting named by the API's key is
 * named by its row's label here, or by the read's label otherwise. */
function refusalLabels(settings: Settings): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.label])), ...LIMITS_LABELS };
}

/** Limits: imports, queries, tools, image export and public requests, as
 * the configuration read reports them. Each number is kept as it changes;
 * what the server decides is drawn locked; the capacities a geocode and
 * a travel-time run have follow the time limits from each write's
 * response, marked Not set up while the service's address is not set,
 * which leads to that address's row on Data & services. */
export function LimitsTab() {
  const { read, error, retry } = useInstanceRead();
  const [answered, setAnswered] = useState<InstanceRead | null>(null);
  useDrawn(!!read);
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={styles.loading}>Loading settings…</p>;
  const now = answered ?? read;
  return <>{LIMITS_CARDS.map(spec => <LimitsCardView key={spec.id} spec={spec} read={read} now={now} onAnswer={setAnswered} />)}</>;
}

function limitsUnit(spec: LimitsCard, settings: Settings, onAnswer: (read: InstanceRead) => void): SaveUnit {
  const keys = spec.rows.flatMap(row => row.kind === "setting" && settings[row.key] ? [row.key] : []);
  return new SaveUnit({
    title: spec.title,
    controls: keys.map(key => unitControlFor(settings[key])),
    kept: Object.fromEntries(keys.map(key => [key, settings[key].value as Value])),
    write: async patch => {
      const answer = await writeInstanceSettings(patch);
      onAnswer(answer);
      return keptValues(answer, keys);
    },
  });
}

function LimitsCardView({ spec, read, now, onAnswer }: {
  spec: LimitsCard;
  /** The read the card's values start from. */
  read: InstanceRead;
  /** The latest the server reported: the read, or a write's response. */
  now: InstanceRead;
  onAnswer: (read: InstanceRead) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [unit, card] = useSaveUnit(spec.id, () => limitsUnit(spec, read.settings, onAnswer));
  useUnitFocus(root, card.focus);
  const words = (message: string) => inLabels(message, refusalLabels(now.settings));
  return <SettingsCard ref={root} id={spec.id} title={spec.title} headingId={`${spec.id}-heading`} head={<ResetSlot unit={unit} card={card} />}>
    <Rows>{spec.rows.map(row => <LimitsRowView key={row.id} row={row} now={now} unit={unit} card={card} words={words} />)}</Rows>
    {card.note && <ErrorNote message={words(card.note.message)} onRetry={card.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
  </SettingsCard>;
}

function LimitsRowView({ row, now, unit, card, words }: {
  row: LimitsRow; now: InstanceRead; unit: SaveUnit; card: UnitSnapshot; words: (message: string) => string;
}) {
  if (row.kind === "capacity") {
    const count = row.of === "geocode" ? now.capacities.geocodeRows : now.capacities.isochroneOrigins;
    const address = dataRowAddress(row.service);
    const after = serviceSetUp(now.settings, row.service) !== false ? undefined
      : address ? <Link href={address} scroll={false} className={styles.link}>Not set up</Link> : "Not set up";
    return <SettingRow id={row.id} label={row.label} meta={row.meta} after={after}><ValueText>{capacityText(row.of, count)}</ValueText></SettingRow>;
  }
  if (row.kind === "image") {
    return <SettingRow id={row.id} label={row.label} meta={row.meta}>
      <LockedField label={row.label} value={`${formatSettingNumber(now.maxImageDimension)} ${row.unit}`} state={{ kind: "fixed", variable: null }} width="m" />
    </SettingRow>;
  }
  const setting = now.settings[row.key];
  if (!setting) return null;
  const decided = serverSetState(setting);
  if (decided) {
    return <SettingRow id={row.id} label={row.label} meta={row.meta}>
      <LockedField label={row.label} value={withShownUnit(row.key, setting.value, setting.unit)} state={decided} width="m" />
    </SettingRow>;
  }
  const range = setting.write?.kind === "integer" ? setting.write : null;
  const error = card.errors[row.key], errorId = `${row.id}-error`;
  return <SettingRow id={row.id} label={row.label} meta={row.meta}>
    <NumberField label={row.label} unitKey={row.key} value={String(card.values[row.key] ?? "")} unit={shownUnit(row.key, setting.unit)}
      min={range?.min} max={range?.max} error={error} errorId={errorId}
      onStep={text => unit.step(row.key, text)} onType={text => unit.edit(row.key, text)} onCommit={() => unit.commit(row.key)} />
    {card.saved.includes(row.key) && <SavedMark />}
    {error && <RowError id={errorId}>{words(error)}</RowError>}
  </SettingRow>;
}
