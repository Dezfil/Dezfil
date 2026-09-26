"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { useSearch } from "./use-search";
import type { SearchAction } from "./rows";
import styles from "./SearchControl.module.css";

/**
 * The header search field: one field in the shell's reserved start
 * slot, one grouped dropdown under it. The keyboard model is the
 * documented exception to the house menu idiom (S8): focus never leaves
 * the input — arrows move a highlight the input names as its active
 * descendant, Enter takes the highlighted row, and Enter without one
 * submits the places-inclusive search. ⌘K and Ctrl-K focus the
 * field from anywhere in the builder, text inputs included — an
 * accelerator to the same field, never a second surface.
 */

const subscribeNever = () => () => {};

const S4_LINE = "Place search needs a geocoding endpoint. Set DEZFIL_GEOCODER_URL.";

export function SearchControl({
  mapId,
  map,
  onAction,
}: {
  mapId: string;
  map: MapWithLayers | null;
  onAction: (action: SearchAction) => void;
}) {
  const { state, type, submit, close, refresh, setActiveId } = useSearch(
    mapId,
    map,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  // The accelerator (S2): from anywhere in the builder, including other
  // text inputs and the SQL editor — the spec's "from anywhere" has no
  // carve-out. It also reopens: when the field is already focused, no
  // focus event will fire, so the shortcut runs the round itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        refresh();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [refresh]);

  // An outside pointer closes the dropdown without taking the field's
  // text; the marker (its own module) is untouched.
  useEffect(() => {
    if (!state.open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [state.open, close]);

  const activate = useCallback(
    (action: SearchAction) => {
      onAction(action);
      close();
    },
    [onAction, close],
  );

  // The popup the user can see is `showPanel`, not `state.open`: a
  // typed query with nothing to show keeps `open` true but renders no
  // panel, and everything popup-shaped — aria-expanded, Escape, the
  // arrow-reopen — must follow what is visible.
  const empty =
    state.rows.flat.length === 0 &&
    (!state.places || state.places.state === "ok");
  const showPanel =
    state.open && (state.rows.flat.length > 0 || state.places !== null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const flat = state.rows.flat;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // No visible panel with text standing: an arrow reopens the
      // round rather than dead-ending (the combobox convention).
      if (!showPanel) {
        refresh();
        return;
      }
      if (flat.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const at =
        state.activeId !== null
          ? flat.findIndex((r) => r.id === state.activeId)
          : delta === 1
            ? -1
            : 0;
      const next = flat[(((at + delta) % flat.length) + flat.length) % flat.length];
      setActiveId(next.id);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = flat.find((r) => r.id === state.activeId);
      if (row) {
        activate(row.action);
      } else {
        submit();
      }
      return;
    }
    if (e.key === "Escape" && showPanel) {
      // Consumed: the document-level marker dismissal reads
      // defaultPrevented and leaves the marker for the next press.
      // With no visible panel the press passes through untouched.
      e.preventDefault();
      close();
    }
  };

  // The highlight must stay visible in a scrolling panel: arrows move
  // aria-activedescendant, which scrolls nothing on its own.
  useEffect(() => {
    if (state.activeId) {
      document
        .getElementById(state.activeId)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [state.activeId]);

  if (!mounted) return null;
  const slot = document.getElementById("header-actions-start");
  if (!slot) return null;

  const active = state.rows.flat.find((r) => r.id === state.activeId) ?? null;

  return createPortal(
    <div ref={rootRef} className={styles.host}>
      <input
        ref={inputRef}
        className={styles.field}
        type="text"
        role="combobox"
        aria-label="Search this map and places"
        aria-expanded={showPanel}
        aria-controls="search-results"
        aria-activedescendant={active?.id}
        aria-autocomplete="list"
        placeholder="Search map & places"
        value={state.query}
        onChange={(e) => type(e.target.value)}
        onFocus={refresh}
        onClick={() => {
          // A click on the already-focused field fires no focus event;
          // reopen the closed panel from here.
          if (!showPanel) refresh();
        }}
        onKeyDown={onKeyDown}
      />
      {showPanel && (
        <div className={styles.panel}>
          <ul id="search-results" role="listbox" className={styles.list}>
            {state.rows.groups.map((group) => (
              <li key={group.key} role="presentation">
                <div className={styles.groupHead}>{group.label}</div>
                <ul role="presentation" className={styles.groupList}>
                  {group.rows.map((row) => (
                    <li
                      key={row.id}
                      id={row.id}
                      role="option"
                      aria-selected={active?.id === row.id}
                      className={styles.row}
                      data-active={active?.id === row.id || undefined}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => activate(row.action)}
                    >
                      <span className={styles.rowLabel}>{row.label}</span>
                      {row.context && (
                        <span className={styles.rowContext}>{row.context}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {group.key === "place" && state.rows.attribution && (
                  <div className={styles.attribution}>
                    {state.rows.attribution}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {state.places?.state === "pending" && (
            <div className={styles.note}>Searching places…</div>
          )}
          {state.places?.state === "unconfigured" && (
            <div className={styles.note}>{S4_LINE}</div>
          )}
          {state.places?.state === "failed" && (
            <div className={styles.note} data-tone="warn">
              {state.places.message}
            </div>
          )}
          {state.submitted &&
            empty &&
            state.places?.state !== "pending" &&
            !state.pending && <div className={styles.note}>No results.</div>}
        </div>
      )}
    </div>,
    slot,
  );
}
