"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { lookChoices, normalizeLook, type Look } from "@/lib/look";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { RerunIcon } from "@/components/ui/icons";
import { accountRequest, failureMessage, settingsWrite } from "./api";
import { choiceLabel, LOOK_CARDS, LookReset, lookTab, shownLook, stampLook, unitKey, type LookCard, type LookResetSnapshot, type LookTab } from "./look-tab";
import { LookPicture } from "./LookPictures";
import { PictureChoice } from "./PictureChoice";
import type { SaveUnit, UnitSnapshot } from "./save-unit";
import { useDrawn } from "./settings-land";
import { RowError, Rows, SettingRow } from "./SettingRows";
import { ResetSlot, SavedMark, SettingsCard } from "./SettingsCard";
import { useUnitFocus } from "./use-save-unit";
import cardStyles from "./SettingsCard.module.css";
import styles from "./AppearanceTab.module.css";

const OWN_SETTINGS = "/api/settings";

/**
 * Appearance: the person's look, four cards of picture rows over the
 * own-settings read and write. A pick changes the page at once (the
 * document's root carries it, as the served page does) and is kept at
 * once; a refused one returns the page to what is kept. Each card has the
 * frame's Reset to defaults; Reset to Dezfil's default at the heading
 * row's right returns every pick in one write. Nothing here is typed, so
 * nothing waits for a Save and the leave guard never asks.
 */
export function AppearanceTab() {
  const [kept, setKept] = useState<Look | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    accountRequest<{ look?: unknown }>(OWN_SETTINGS).then(body => {
      if (!cancelled) { setKept(normalizeLook(body.look)); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  useDrawn(!!kept);
  if (error) return <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />;
  if (!kept) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <LookCards kept={kept} />;
}

/** The four units and the tab-wide reset, made once for the tab's life,
 * every write through one writer. */
function createTab(kept: Look): LookTab {
  return lookTab(kept, patch => settingsWrite<{ look?: unknown }>(OWN_SETTINGS, "PATCH", { look: patch }).then(body => normalizeLook(body.look)));
}

/** Every unit's snapshot, one stable list per change. */
function useSnapshots(units: readonly SaveUnit[]): readonly UnitSnapshot[] {
  const cache = useRef<readonly UnitSnapshot[]>([]);
  const read = () => {
    const now = units.map(unit => unit.snapshot);
    if (now.length !== cache.current.length || now.some((snapshot, index) => snapshot !== cache.current[index])) cache.current = now;
    return cache.current;
  };
  const subscribe = useCallback((listener: () => void) => {
    const stops = units.map(unit => unit.subscribe(listener));
    return () => { for (const stop of stops) stop(); };
  }, [units]);
  return useSyncExternalStore(subscribe, read, read);
}

function LookCards({ kept }: { kept: Look }) {
  const [{ units, reset }] = useState(() => createTab(kept));
  const snapshots = useSnapshots(units);
  const follow = useCallback((listener: () => void) => reset.subscribe(listener), [reset]);
  const top = useSyncExternalStore(follow, () => reset.snapshot, () => reset.snapshot);
  const shown = shownLook(snapshots);
  const shownKey = JSON.stringify(shown);
  // The page follows what the rows show, before any answer: a refused pick
  // shows what is kept again.
  useLayoutEffect(() => { stampLook(document.documentElement, JSON.parse(shownKey) as Look); }, [shownKey]);
  // Leaving the tab: the cards' Undo and Saved marks go, and the tab-wide Undo with them.
  useEffect(() => () => { for (const unit of units) unit.leave(); reset.leave(); }, [units, reset]);
  /** A newer pick or a card's Reset lets the tab-wide Undo go. */
  const newer = () => reset.drop();
  return <div className={styles.tab}>
    <TopAction reset={reset} snapshot={top} shown={shown} />
    {top.note && <ErrorNote message={top.note.message} onRetry={() => reset.retry(shown)} onDismiss={() => reset.dismiss()} />}
    {LOOK_CARDS.map((card, index) => <LookCardView key={card.id} card={card} unit={units[index]} snapshot={snapshots[index]} onNewer={newer} />)}
  </div>;
}

/** Reset to Dezfil's default, then Undo in its place, at the right of the
 * page's heading row: it takes no room above the cards. */
function TopAction({ reset, snapshot, shown }: { reset: LookReset; snapshot: LookResetSnapshot; shown: Look }) {
  const slot = reset.slot(shown);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(0);
  useEffect(() => {
    const focus = snapshot.focus;
    if (!focus || focus.seq === done.current) return;
    done.current = focus.seq;
    box.current?.querySelector<HTMLElement>(`[data-appearance-slot="${focus.to}"]`)?.focus();
  }, [snapshot.focus, slot]);
  return <div ref={box} className={styles.top} data-appearance-top="">
    {slot === "reset" && <Button data-appearance-slot="reset" busy={snapshot.busy} onClick={() => reset.reset(shown)}>
      <RerunIcon />Reset to Dezfil&apos;s default
    </Button>}
    {slot === "undo" && <Button data-appearance-slot="undo" aria-label="Undo reset to Dezfil's default" busy={snapshot.busy}
      data-leaving={snapshot.leaving || undefined} onClick={() => reset.undo()}
      onFocus={() => reset.hold("focus", true)} onBlur={() => reset.hold("focus", false)}
      onPointerEnter={() => reset.hold("pointer", true)} onPointerLeave={() => reset.hold("pointer", false)}>Undo</Button>}
  </div>;
}

function LookCardView({ card, unit, snapshot, onNewer }: { card: LookCard; unit: SaveUnit; snapshot: UnitSnapshot; onNewer: () => void }) {
  const root = useRef<HTMLElement>(null);
  useUnitFocus(root, snapshot.focus);
  return <SettingsCard ref={root} id={card.id} title={card.title} headingId={`${card.id}-heading`}
    head={<ResetSlot unit={unit} card={snapshot} onReset={onNewer} />}>
    <Rows>{card.rows.map(row => {
      const key = unitKey(row.key), error = snapshot.errors[key];
      return <SettingRow key={row.id} id={row.id} label={row.label} stack mark={snapshot.saved.includes(key) ? <SavedMark /> : null}>
        <PictureChoice label={row.label} value={String(snapshot.values[key])}
          choices={lookChoices(row.key).map(value => ({ value, label: choiceLabel(row.key, value), picture: <LookPicture pick={row.key} value={value} /> }))}
          onChange={value => { onNewer(); unit.choose(key, value); }} />
        {error && <RowError id={`${row.id}-error`}>{error}</RowError>}
      </SettingRow>;
    })}</Rows>
    {snapshot.note && <ErrorNote message={snapshot.note.message} onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
  </SettingsCard>;
}
