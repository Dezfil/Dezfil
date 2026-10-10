"use client";
import { useId, useRef } from "react";
import type { ServiceTestAnswer } from "@/lib/settings/service-test-answer";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextInput } from "@/components/ui/Field";
import { keptValues, writeInstanceSettings, type InstanceRead } from "./instance-read";
import { imageryState, LIBRARIES_LABELS, SATELLITE_ADDRESS_ROW, SATELLITE_CARD, SATELLITE_CREDIT_ROW, satelliteTestWords } from "./libraries-table";
import { inLabels } from "./limits-table";
import { useLiveValue } from "./live-values";
import { SaveUnit, type Value } from "./save-unit";
import { serverSetState, unitControlFor, type ReadSetting } from "./server-set";
import { ServiceAddressRow } from "./ServiceAddressRow";
import { TestLine } from "./ServiceChecks";
import { LockedField, RowError, Rows, SettingRow } from "./SettingRows";
import { SavedMark, SaveLine, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import dataStyles from "./DataTab.module.css";
import styles from "./LibrariesTab.module.css";

type Settings = InstanceRead["settings"];

/**
 * Libraries' Satellite imagery: this instance's own imagery, so no Reset.
 * The tile address is the Data & services address row: what is in
 * effect shown as scheme and host (or set and unreadable) over an empty
 * field, a pasted address kept on Save and never shown again, Remove
 * behind its question; the Test reaches one tile at the address in
 * effect. The credit is typed text kept on Save. A row the server's
 * environment sets is the locked field naming its variable. The address
 * never reaches the search; the credit does, as typed.
 */
export function SatelliteCard({ read, now, onAnswer }: {
  /** The read the credit starts from. */
  read: InstanceRead;
  /** The latest the server reported: the read, or a write's response. */
  now: InstanceRead;
  onAnswer: (read: InstanceRead) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const state = imageryState(now.settings);
  const end = state === "none" ? <span className={dataStyles.chip}>Not set up</span>
    : <TestLine<ServiceTestAnswer> path="/api/instance/services/satellite/test" words={satelliteTestWords} />;
  return <SettingsCard ref={root} id={SATELLITE_CARD.id} title={SATELLITE_CARD.title} headingId={`${SATELLITE_CARD.id}-heading`}
    head={<span className={dataStyles.headEnd}>{end}</span>}>
    <Rows>
      <ServiceAddressRow row={SATELLITE_ADDRESS_ROW} setting={now.settings[SATELLITE_ADDRESS_ROW.key]} card={SATELLITE_CARD.title}
        onAnswer={onAnswer} labels={LIBRARIES_LABELS} />
      <CreditRow settings={read.settings} root={root} onAnswer={onAnswer} />
    </Rows>
  </SettingsCard>;
}

function creditUnit(setting: ReadSetting, onAnswer: (read: InstanceRead) => void): SaveUnit {
  return new SaveUnit({
    title: SATELLITE_CARD.title,
    controls: [unitControlFor(setting, { reset: false })],
    kept: { [SATELLITE_CREDIT_ROW.key]: setting.value as Value },
    write: async patch => {
      const answer = await writeInstanceSettings(patch);
      onAnswer(answer);
      return keptValues(answer, [SATELLITE_CREDIT_ROW.key]);
    },
  });
}

/** The credit: typed, kept on Save (or Enter), Saved after the response;
 * locked with its variable where the environment sets it. */
function CreditRow({ settings, root, onAnswer }: { settings: Settings; root: { readonly current: HTMLElement | null }; onAnswer: (read: InstanceRead) => void }) {
  const ids = useId();
  const setting = settings[SATELLITE_CREDIT_ROW.key];
  const [unit, snapshot] = useSaveUnit(SATELLITE_CREDIT_ROW.id, () => creditUnit(setting, onAnswer));
  useUnitFocus(root, snapshot.focus);
  const text = String(snapshot.values[SATELLITE_CREDIT_ROW.key] ?? "");
  useLiveValue(SATELLITE_CREDIT_ROW.id, text);
  const decided = serverSetState(setting);
  if (decided) {
    return <SettingRow id={SATELLITE_CREDIT_ROW.id} label={SATELLITE_CREDIT_ROW.label}>
      <LockedField label={SATELLITE_CREDIT_ROW.label} value={String(setting.value ?? "")} state={decided} />
    </SettingRow>;
  }
  const error = snapshot.errors[SATELLITE_CREDIT_ROW.key], errorId = `${ids}-error`;
  return <SettingRow id={SATELLITE_CREDIT_ROW.id} label={SATELLITE_CREDIT_ROW.label}>
    <form className={styles.credit} noValidate onSubmit={event => { event.preventDefault(); unit.save(); }}>
      <span className={styles.creditLine}>
        <TextInput className={styles.creditField} aria-label={SATELLITE_CREDIT_ROW.label} data-unit-key={SATELLITE_CREDIT_ROW.key} value={text}
          maxLength={SATELLITE_CREDIT_ROW.maxLength} disabled={snapshot.busy} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
          onChange={event => unit.edit(SATELLITE_CREDIT_ROW.key, event.target.value)} />
        {snapshot.saved.includes(SATELLITE_CREDIT_ROW.key) && <SavedMark />}
      </span>
      {error && <RowError id={errorId}>{inLabels(error, LIBRARIES_LABELS)}</RowError>}
      {snapshot.note && <ErrorNote message={inLabels(snapshot.note.message, LIBRARIES_LABELS)}
        onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
      {snapshot.saveLine && <SaveLine busy={snapshot.busy} onCancel={() => unit.cancel()} />}
    </form>
  </SettingRow>;
}
