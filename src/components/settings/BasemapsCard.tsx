"use client";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { BasemapThumb } from "@/components/map/BasemapThumb";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextInput } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { MapIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { SwitchRow } from "@/components/ui/Switch";
import { accountRequest, failureMessage, settingsWrite } from "./api";
import { keptValues, writeInstanceSettings, type InstanceRead } from "./instance-read";
import {
  BASEMAP_SWITCHES, BASEMAPS_CARD, builtInMeta, builtInRows, hostOf, LIBRARIES_LABELS, libraryStyleRowId, SINGLE_MAP_ROW, STYLE_LIMITS,
  STYLE_PUBLIC, STYLE_REMOVAL, type BuiltInStyleRow, type LibraryStyleRead,
} from "./libraries-table";
import { inLabels } from "./limits-table";
import { SaveUnit, type UnitSnapshot, type Value } from "./save-unit";
import { useMoment } from "./ServiceChecks";
import { unitControlFor } from "./server-set";
import { useGuardEntry } from "./settings-guard";
import { RowError, Rows, SettingRow } from "./SettingRows";
import { CardActions, LabelledField, Note, ResetSlot, SavedMark, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import cardStyles from "./SettingsCard.module.css";
import dataStyles from "./DataTab.module.css";
import styles from "./LibrariesTab.module.css";

type Settings = InstanceRead["settings"];
const LIBRARY = "/api/instance/basemaps";

/**
 * Libraries' Basemaps: every style a person may be offered where a basemap
 * is chosen. The built-in styles with their captures, Satellite while
 * imagery is set up (its host), then the styles added by their address
 * (name and host), each with Offered kept at once and Saved after the
 * server accepted; an added style also Remove, which asks first. Add a
 * style opens in place: a name and the style's address, read once by the
 * server as it is added, which takes time; the form says the address is
 * public. Under the list, whether a map may take a style address of its
 * own. Reset returns the built-in styles', Satellite's and that switch's
 * defaults, never an added style, then offers Undo.
 */
export function BasemapsCard({ read, now, onAnswer }: {
  /** The read the card's switches start from. */
  read: InstanceRead;
  /** The latest the server reported: the read, or a write's response. */
  now: InstanceRead;
  onAnswer: (read: InstanceRead) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [unit, snapshot] = useSaveUnit(BASEMAPS_CARD.id, () => switchesUnit(read.settings, onAnswer));
  useUnitFocus(root, snapshot.focus);
  const [library, setLibrary] = useState<readonly LibraryStyleRead[]>(read.basemapStyles ?? []);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null), [addedShown, showAdded] = useMoment();
  const [removing, setRemoving] = useState<LibraryStyleRead | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // Focus back to Add a style as the form closes.
  const opened = useRef(false);
  useEffect(() => {
    if (!adding && opened.current) opener.current?.focus();
    opened.current = adding;
  }, [adding]);
  const rows = builtInRows(now.settings);
  const head = <>
    <ResetSlot unit={unit} card={snapshot} />
    {!adding && <Button ref={opener} variant="primary" onClick={() => setAdding(true)}><PlusIcon />Add a style</Button>}
  </>;
  const closeForm = () => setAdding(false);
  return <SettingsCard ref={root} id={BASEMAPS_CARD.id} title={BASEMAPS_CARD.title} count={String(rows.length + library.length)}
    headingId={`${BASEMAPS_CARD.id}-heading`} head={head}>
    {adding && <AddStyleForm onAdded={style => {
      setLibrary(current => [...current, style]); setAdded(style.id); showAdded(); closeForm();
    }} onCancel={closeForm} />}
    <ul className={`${cardStyles.list} ${styles.styles}`}>
      {rows.map(row => <BuiltInRow key={row.key} row={row} settings={now.settings} unit={unit} snapshot={snapshot} />)}
      {library.map(style => <LibraryRow key={style.id} style={style} added={addedShown && added === style.id}
        onChanged={next => setLibrary(current => current.map(each => each.id === next.id ? next : each))}
        onRemove={() => setRemoving(style)} />)}
    </ul>
    <Rows>
      <SettingRow id={SINGLE_MAP_ROW.id} label={SINGLE_MAP_ROW.label}>
        <SwitchRow label={SINGLE_MAP_ROW.on} aria-label={SINGLE_MAP_ROW.label} data-unit-key={SINGLE_MAP_ROW.key}
          checked={snapshot.values[SINGLE_MAP_ROW.key] === true} onChange={event => unit.choose(SINGLE_MAP_ROW.key, event.target.checked)} />
        {snapshot.saved.includes(SINGLE_MAP_ROW.key) && <SavedMark />}
        {snapshot.errors[SINGLE_MAP_ROW.key] && <RowError id={`${SINGLE_MAP_ROW.id}-error`}>{inLabels(snapshot.errors[SINGLE_MAP_ROW.key], LIBRARIES_LABELS)}</RowError>}
      </SettingRow>
    </Rows>
    {snapshot.note && <ErrorNote message={inLabels(snapshot.note.message, LIBRARIES_LABELS)}
      onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
    {removing && <RemoveStyle style={removing} onRemoved={() => { setLibrary(current => current.filter(each => each.id !== removing.id)); setRemoving(null); }}
      onClose={() => setRemoving(null)} />}
  </SettingsCard>;
}

/** The five switches as one save unit over the instance write: kept at
 * once, Saved after the response, Reset to their defaults then Undo. */
function switchesUnit(settings: Settings, onAnswer: (read: InstanceRead) => void): SaveUnit {
  const keys = BASEMAP_SWITCHES.filter(key => settings[key]);
  return new SaveUnit({
    title: BASEMAPS_CARD.title,
    controls: keys.map(key => unitControlFor(settings[key])),
    kept: Object.fromEntries(keys.map(key => [key, settings[key].value as Value])),
    write: async patch => {
      const answer = await writeInstanceSettings(patch);
      onAnswer(answer);
      return keptValues(answer, keys);
    },
  });
}

/** A style's picture: a built-in style's capture, or the plain map mark of an added one. */
function Picture({ style }: { style: BuiltInStyleRow["key"] | null }) {
  return <span className={styles.thumb} aria-hidden="true">
    {style ? <BasemapThumb style={style} fill /> : <span className={styles.styleArt}><MapIcon /></span>}
  </span>;
}

function StyleLead({ style, name, meta }: { style: BuiltInStyleRow["key"] | null; name: string; meta: string }) {
  return <div className={styles.lead}>
    <Picture style={style} />
    <div className={cardStyles.listMain}><strong>{name}</strong>{meta && <span className={cardStyles.note}>{meta}</span>}</div>
  </div>;
}

function BuiltInRow({ row, settings, unit, snapshot }: { row: BuiltInStyleRow; settings: Settings; unit: SaveUnit; snapshot: UnitSnapshot }) {
  const error = snapshot.errors[row.setting];
  return <li id={row.id} className={`${cardStyles.listRow} ${styles.styleRow}`}>
    <StyleLead style={row.key} name={row.label} meta={builtInMeta(row, settings)} />
    <span className={styles.acts}>
      {snapshot.saved.includes(row.setting) && <SavedMark />}
      <SwitchRow label="Offered" aria-label={`Offer ${row.label}`} data-unit-key={row.setting} checked={snapshot.values[row.setting] === true}
        onChange={event => unit.choose(row.setting, event.target.checked)} />
    </span>
    {error && <RowError id={`${row.id}-error`}>{inLabels(error, LIBRARIES_LABELS)}</RowError>}
  </li>;
}

/** An added style: Offered kept at once through the library's own
 * operation, Saved after it answered, the switch back where it was on a
 * refusal; Remove asks first. */
function LibraryRow({ style, added, onChanged, onRemove }: {
  style: LibraryStyleRead;
  added: boolean;
  onChanged: (style: LibraryStyleRead) => void;
  onRemove: () => void;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, showSaved, hideSaved] = useMoment();
  const latest = useRef(0);
  async function offer(next: boolean) {
    const ask = ++latest.current;
    setPending(next); setError(null); hideSaved();
    try {
      const answer = await settingsWrite<LibraryStyleRead>(`${LIBRARY}/${encodeURIComponent(style.id)}`, "PATCH", { offered: next });
      if (ask !== latest.current) return;
      onChanged(answer); showSaved();
    } catch (failure) {
      if (ask === latest.current) setError(failureMessage(failure));
    } finally { if (ask === latest.current) setPending(null); }
  }
  return <li id={libraryStyleRowId(style.id)} className={`${cardStyles.listRow} ${styles.styleRow}`}>
    <StyleLead style={null} name={style.name} meta={hostOf(style.url)} />
    <span className={styles.acts}>
      {(saved || added) && <SavedMark text={added ? "Added" : "Saved"} />}
      <SwitchRow label="Offered" aria-label={`Offer ${style.name}`} checked={pending ?? style.offered} disabled={pending !== null}
        onChange={event => void offer(event.target.checked)} />
      <IconButton icon={<TrashIcon />} tone="danger" action={`Remove ${style.name}`} onClick={onRemove} />
    </span>
    {error && <RowError id={`${libraryStyleRowId(style.id)}-error`}>{error}</RowError>}
  </li>;
}

/** Remove an added style, once asked. */
function RemoveStyle({ style, onRemoved, onClose }: { style: LibraryStyleRead; onRemoved: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true); setError(null);
    try {
      await accountRequest(`${LIBRARY}/${encodeURIComponent(style.id)}`, "DELETE");
      onRemoved();
    } catch (failure) { setError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  const close = () => { if (!busy) onClose(); };
  return <Dialog label={`Remove ${style.name}`} className={cardStyles.dialog} onClose={close}>
    <h2>Remove {style.name}?</h2>
    <p>{STYLE_REMOVAL}</p>
    {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
    <CardActions>
      <Button variant="danger" busy={busy} onClick={() => void remove()}>Remove style</Button>
      <Button disabled={busy} onClick={close}>Cancel</Button>
    </CardActions>
  </Dialog>;
}

/** Add a style by its address: kept once the server has read it. Typed
 * text holds the page; Cancel or Escape lets it go. The address never
 * reaches the search. */
function AddStyleForm({ onAdded, onCancel }: { onAdded: (style: LibraryStyleRead) => void; onCancel: () => void }) {
  const ids = useId();
  const [name, setName] = useState(""), [url, setUrl] = useState("");
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null), urlField = useRef<HTMLInputElement>(null);
  useGuardEntry("basemaps-new", name !== "" || url !== "" || busy, BASEMAPS_CARD.title);
  useEffect(() => { nameField.current?.focus(); }, []);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problems = { ...(name.trim() ? {} : { name: "Name the style." }), ...(url.trim() ? {} : { url: "Enter the style’s address." }) };
    setErrors(problems);
    if (problems.name || problems.url) { (problems.name ? nameField : urlField).current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      onAdded(await accountRequest<LibraryStyleRead>(LIBRARY, "POST", { name: name.trim(), url: url.trim() }));
    } catch (failure) { setError(failureMessage(failure)); setBusy(false); }
  }
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); } };
  const fields = { name: `${ids}-name`, url: `${ids}-url` };
  return <form className={styles.form} noValidate onSubmit={event => void add(event)} onKeyDown={escape}>
    <LabelledField label="Name" inputId={fields.name} error={errors.name} errorId={`${fields.name}-error`}>
      <TextInput ref={nameField} id={fields.name} value={name} maxLength={STYLE_LIMITS.name} disabled={busy} autoComplete="off"
        aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? `${fields.name}-error` : undefined}
        onChange={event => { setName(event.target.value); setErrors(current => ({ ...current, name: undefined })); }} />
    </LabelledField>
    <LabelledField label="Style address" inputId={fields.url} error={errors.url} errorId={`${fields.url}-error`}>
      <TextInput ref={urlField} id={fields.url} className={dataStyles.addressField} type="url" inputMode="url" value={url} maxLength={STYLE_LIMITS.address}
        placeholder="https://tiles.example.org/styles/basic/style.json" disabled={busy} autoComplete="off" spellCheck={false}
        aria-invalid={errors.url ? true : undefined} aria-describedby={errors.url ? `${fields.url}-error` : undefined}
        onChange={event => { setUrl(event.target.value); setErrors(current => ({ ...current, url: undefined })); }} />
    </LabelledField>
    <Note>{STYLE_PUBLIC}</Note>
    {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
    <CardActions>
      <Button type="submit" variant="primary" busy={busy} disabled={!name && !url}>Add style</Button>
      <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
    </CardActions>
  </form>;
}
