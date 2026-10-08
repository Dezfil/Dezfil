"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextInput } from "@/components/ui/Field";
import { failureMessage } from "./api";
import { addressState, addressWords, DATA_LABELS, type AddressRow } from "./data-table";
import { writeInstanceSettings, type InstanceRead } from "./instance-read";
import { inLabels } from "./limits-table";
import { rowRefusals, SAVED_HOLD_MS, WriteRefusal } from "./save-unit";
import { serverSetState, type ReadSetting } from "./server-set";
import { useGuardEntry } from "./settings-guard";
import { LockedField, RowError, SettingRow, ValueText } from "./SettingRows";
import { CardActions, SavedMark, SaveLine } from "./SettingsCard";
import cardStyles from "./SettingsCard.module.css";
import styles from "./DataTab.module.css";

/**
 * A service's address: its own small form, outside its card's numbers, so
 * the card's Reset never touches it. What is in effect shows above an
 * empty field: a saved address as its scheme and host with Set and
 * Remove, OpenStreetMap's public server or Amazon S3 with Default, or a
 * saved address the instance's key cannot read. An address is pasted
 * whole and kept on Save, never shown again; Remove asks first. Set by
 * the server's environment, the row is the locked field naming its
 * variable.
 *
 * Typed text holds the page as any typed text does, but it never reaches
 * the search: an address may carry a key.
 */
export function ServiceAddressRow({ row, setting, card, onAnswer }: {
  row: AddressRow;
  setting: ReadSetting | undefined;
  /** The card's title, which the leave guard names. */
  card: string;
  onAnswer: (read: InstanceRead) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false), [removeError, setRemoveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useGuardEntry(row.id, text !== "" || busy, card);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!setting) return null;

  const decided = serverSetState(setting);
  if (decided) {
    return <SettingRow id={row.id} label={row.label} meta={row.meta}>
      <LockedField label={row.name} value={addressWords(row, setting)} mono state={decided} />
    </SettingRow>;
  }

  const state = addressState(row, setting);
  const flash = () => {
    if (timer.current) clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => { timer.current = null; setSaved(false); }, SAVED_HOLD_MS);
  };
  const write = async (value: string | null) => onAnswer(await writeInstanceSettings({ [row.key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await write(text.trim());
      setText("");
      flash();
    } catch (failure) {
      // The server's reason, after the key it names; never the address.
      const message = failureMessage(failure);
      setError(failure instanceof WriteRefusal ? rowRefusals(message, [row.key])[row.key] ?? inLabels(message, DATA_LABELS) : message);
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setRemoveError(null);
    try {
      await write(null);
      setRemoving(false);
      flash();
    } catch (failure) { setRemoveError(failureMessage(failure)); }
    finally { setBusy(false); }
  }

  const close = () => { if (!busy) { setRemoving(false); setRemoveError(null); } };
  const errorId = `${id}-error`;
  return <SettingRow id={row.id} label={row.label} meta={row.meta}>
    <form className={styles.address} noValidate onSubmit={event => void save(event)}>
      {state.kind !== "none" && <span className={styles.inEffect}>
        {state.kind === "saved" && <ValueText mono>{state.origin}</ValueText>}
        {state.kind === "default" && <ValueText mono={state.mono}>{state.text}</ValueText>}
        <span className={styles.chip}>{state.kind === "default" ? "Default" : "Set"}</span>
        {state.kind !== "default" && <Button variant="quiet" disabled={busy} aria-label={`Remove ${row.name}`}
          onClick={() => { setRemoveError(null); setRemoving(true); }}>Remove</Button>}
        {saved && <SavedMark />}
      </span>}
      {state.kind === "unreadable" && <RowError id={`${id}-unreadable`}>The instance’s encryption key cannot read the saved address. Save it again.</RowError>}
      <TextInput className={styles.addressField} type="url" inputMode="url" autoComplete="off" spellCheck={false} aria-label={row.name}
        placeholder={row.placeholder} value={text} disabled={busy} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={event => { setText(event.target.value); setError(null); setSaved(false); }} />
      {state.kind === "none" && saved && <SavedMark />}
      {error && <RowError id={errorId}>{error}</RowError>}
      {text !== "" && <SaveLine busy={busy} onCancel={() => { setText(""); setError(null); }} />}
    </form>
    {removing && <Dialog label="Remove the saved address" className={cardStyles.dialog} onClose={close}>
      <h2>Remove the saved address?</h2>
      <p>{row.removal}</p>
      {removeError && <ErrorNote message={removeError} onDismiss={() => setRemoveError(null)} />}
      <CardActions>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>Remove address</Button>
        <Button disabled={busy} onClick={close}>Cancel</Button>
      </CardActions>
    </Dialog>}
  </SettingRow>;
}
