"use client";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CustomPalette } from "@/lib/metadata/palettes";
import { GradientRamp } from "@/components/GradientRamp";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextInput } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { MinusIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { accountRequest, failureMessage } from "./api";
import { useMoment } from "./ServiceChecks";
import { colorsWords, evenStops, NEW_PALETTE_ROW, PALETTE_LIMITS, PALETTES_CARD, paletteRowId, rampGradient, STARTING_COLORS } from "./palettes-table";
import { useGuardEntry } from "./settings-guard";
import { useDrawn } from "./settings-land";
import { CardActions, LabelledField, Note, SavedMark, SettingsCard } from "./SettingsCard";
import cardStyles from "./SettingsCard.module.css";
import styles from "./PalettesCard.module.css";

/**
 * Libraries' Palettes: the palettes people saved, as every map's palette
 * picker lists them, each with its name, its ramp and how many colors it
 * has. Add a palette opens in place: a name and 2 to 16 colors, evenly
 * spaced along the ramp drawn live above them, kept by Add palette and
 * offered in every picker at once. Delete asks first; a layer that used
 * the palette keeps its colors. Both go through the palette operations
 * every account uses from the builder, so a member saving or deleting
 * there is what this list shows.
 */

const PALETTES = "/api/palettes";

export function PalettesCard() {
  const ids = useId();
  const [palettes, setPalettes] = useState<CustomPalette[] | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""), [colors, setColors] = useState<readonly string[]>(STARTING_COLORS);
  const [nameError, setNameError] = useState<string | null>(null), [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null), [addedShown, showAdded] = useMoment();
  const [deleting, setDeleting] = useState<CustomPalette | null>(null), [deleteError, setDeleteError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null), nameField = useRef<HTMLInputElement>(null);
  const changed = name !== "" || colors.join() !== STARTING_COLORS.join();
  useGuardEntry("palettes-new", adding && (changed || busy), PALETTES_CARD.title);
  useDrawn(palettes !== null || error !== null);
  useEffect(() => {
    let cancelled = false;
    accountRequest<{ custom: CustomPalette[] }>(PALETTES).then(body => {
      if (!cancelled) { setPalettes(body.custom); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  // Focus to the name as the form opens, and back to Add a palette as it closes.
  const opened = useRef(false);
  useEffect(() => {
    if (adding) nameField.current?.focus();
    else if (opened.current) opener.current?.focus();
    opened.current = adding;
  }, [adding]);

  function close() {
    setAdding(false); setName(""); setColors(STARTING_COLORS); setNameError(null); setAddError(null);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const label = name.trim();
    if (!label) { setNameError("Name the palette."); nameField.current?.focus(); return; }
    setBusy(true); setAddError(null);
    try {
      const saved = await accountRequest<CustomPalette>(PALETTES, "POST", { label, stops: evenStops(colors) });
      setPalettes(current => [...(current ?? []), saved]);
      setAdded(saved.name); showAdded();
      close();
    } catch (failure) { setAddError(failureMessage(failure)); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true); setDeleteError(null);
    try {
      await accountRequest(`${PALETTES}/${encodeURIComponent(deleting.name)}`, "DELETE");
      setPalettes(current => current?.filter(palette => palette.name !== deleting.name) ?? null);
      setDeleting(null);
    } catch (failure) { setDeleteError(failureMessage(failure)); }
    finally { setBusy(false); }
  }

  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.preventDefault(); close(); } };
  const closeDialog = () => { if (!busy) { setDeleting(null); setDeleteError(null); } };
  const nameId = `${ids}-name`, nameErrorId = `${ids}-name-error`;
  return <SettingsCard id={PALETTES_CARD.id} title={PALETTES_CARD.title} count={palettes ? String(palettes.length) : undefined}
    headingId={`${PALETTES_CARD.id}-heading`}
    head={!adding && palettes && <Button ref={opener} onClick={() => setAdding(true)}><PlusIcon />Add a palette</Button>}>
    {error && <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />}
    {!palettes && !error && <p role="status" className={cardStyles.loading}>Loading…</p>}
    {adding && <form className={styles.form} noValidate onSubmit={event => void add(event)} onKeyDown={escape}>
      <LabelledField id={NEW_PALETTE_ROW.id} label="Name" inputId={nameId} error={nameError} errorId={nameErrorId}>
        <TextInput ref={nameField} id={nameId} value={name} maxLength={PALETTE_LIMITS.name} disabled={busy} autoComplete="off"
          aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? nameErrorId : undefined}
          onChange={event => { setName(event.target.value); setNameError(null); }} />
      </LabelledField>
      <div className={styles.colorsField} role="group" aria-labelledby={`${ids}-colors`}>
        <span id={`${ids}-colors`} className={styles.colorsLabel}>Colors</span>
        <div className={styles.stops}>
          <span className={styles.stopList}>{colors.map((color, index) => <input key={index} type="color" className={styles.stop} value={color}
            aria-label={`Color ${index + 1}`} disabled={busy}
            onChange={event => setColors(current => current.map((each, at) => at === index ? event.target.value : each))} />)}</span>
          <IconButton icon={<MinusIcon />} action="Remove the last color" disabled={busy || colors.length <= PALETTE_LIMITS.colors.min}
            onClick={() => setColors(current => current.slice(0, -1))} />
          <IconButton icon={<PlusIcon />} action="Add a color" disabled={busy || colors.length >= PALETTE_LIMITS.colors.max}
            onClick={() => setColors(current => [...current, current[current.length - 1]])} />
          <GradientRamp className={styles.ramp} gradient={rampGradient(evenStops(colors))} data-ramp="new" />
        </div>
      </div>
      {addError && <ErrorNote message={addError} onDismiss={() => setAddError(null)} />}
      <CardActions>
        <Button type="submit" variant="primary" busy={busy} disabled={!changed}>Add palette</Button>
        <Button variant="quiet" disabled={busy} onClick={close}>Cancel</Button>
      </CardActions>
    </form>}
    {palettes?.length === 0 && <Note>No saved palettes yet.</Note>}
    {!!palettes?.length && <ul className={cardStyles.list}>{palettes.map(palette => <li key={palette.name} id={paletteRowId(palette.name)} className={cardStyles.listRow}>
      <div className={cardStyles.listMain}>
        <strong>{palette.label}</strong>
        <span className={cardStyles.note}>{colorsWords(palette.stops.length)}</span>
      </div>
      <span className={styles.rowEnd}>
        {addedShown && added === palette.name && <SavedMark text="Added" />}
        <GradientRamp className={styles.ramp} gradient={rampGradient(palette.stops)} data-ramp={palette.name} />
        <IconButton icon={<TrashIcon />} tone="danger" action={`Delete ${palette.label}`} disabled={busy}
          onClick={() => { setDeleteError(null); setDeleting(palette); }} />
      </span>
    </li>)}</ul>}
    {deleting && <Dialog label={`Delete ${deleting.label}`} className={cardStyles.dialog} onClose={closeDialog}>
      <h2>Delete {deleting.label}?</h2>
      <p>Layers that use it keep their colors.</p>
      {deleteError && <ErrorNote message={deleteError} onDismiss={() => setDeleteError(null)} />}
      <CardActions>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>Delete palette</Button>
        <Button disabled={busy} onClick={closeDialog}>Cancel</Button>
      </CardActions>
    </Dialog>}
  </SettingsCard>;
}
