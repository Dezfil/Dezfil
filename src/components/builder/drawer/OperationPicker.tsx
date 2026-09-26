"use client";

import { useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import { ErrorNote } from "../../ui/ErrorNote";
import { OperationGlyph } from "../../ui/operation-icons";
import { Spinner } from "../../Spinner";
import styles from "./OperationPicker.module.css";

/**
 * The operation catalog, as the drawer offers it.
 *
 * **One searchable catalog, rendered from the API's own description of the
 * verbs**, reachable both from the chain and from a layer's *Analyze…*.
 *
 * Nothing here knows any verb by name. A verb a later spec adds appears
 * because the catalog describes it — which is also what stops the picker
 * offering something this instance cannot run.
 */
export function OperationPicker({
  operations,
  error,
  suggestions,
  suggestedFor,
  onPick,
}: {
  operations: OperationDef[] | null;
  error: string | null;
  /** The door's cold-start offer: verbs that fit the
   * origin layer's data, led as their own group above the full catalog —
   * inherited from the chain's empty state, which left with the pivot. */
  suggestions?: OperationDef[];
  /** The table the suggestions fit, for the group's eyebrow. */
  suggestedFor?: string | null;
  onPick: (operation: OperationDef) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matching = (operations ?? []).filter(
    (o) =>
      needle === "" ||
      o.label.toLowerCase().includes(needle) ||
      o.group.toLowerCase().includes(needle) ||
      // The blurb is the text on the row: matching the hidden reference
      // text made rows vanish for words they visibly carry and appear
      // for words they don't (review).
      o.blurb.toLowerCase().includes(needle),
  );
  const groups = [...new Set(matching.map((o) => o.group))];

  return (
    <div className={styles.picker} data-operation-picker>
      <div className={styles.head}>
        <input
          className={styles.search}
          type="search"
          autoFocus
          value={query}
          aria-label="Search operations"
          placeholder="Search operations…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <ErrorNote message={error} />}
      {operations === null && (
        <p className={styles.hint}>
          <Spinner /> Loading operations…
        </p>
      )}
      {operations !== null && matching.length === 0 && (
        <p className={styles.hint}>No operation matches “{query}”.</p>
      )}
      {needle === "" && suggestedFor && (suggestions ?? []).length > 0 && (
        <div className={styles.group} data-suggested-group>
          <p className={styles.eyebrow}>Suggested for {suggestedFor}</p>
          {(suggestions ?? []).map((operation) => (
            <button
              key={operation.id}
              className={styles.row}
              data-operation-suggested={operation.id}
              data-grp={operation.group}
              onClick={() => onPick(operation)}
            >
              <span className={styles.glyph}>
                <OperationGlyph symbol={operation.symbol} />
              </span>
              <span className={styles.text}>
                <span className={styles.name}>{operation.label}</span>
                <span className={styles.blurb}>{operation.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {groups.map((group) => (
        <div key={group} className={styles.group} data-catalog-group={group}>
          <p className={styles.eyebrow}>{group}</p>
          {matching
            .filter((o) => o.group === group)
            .map((operation) => {
              // **Absence means available.** A verb that declares no
              // requirement carries no answer, and reading that as unavailable
              // would hide every verb from an older instance's catalog.
              const unavailable = operation.availability?.available === false;
              return (
                <button
                  key={operation.id}
                  className={styles.row}
                  data-operation={operation.id}
                  data-grp={operation.group}
                  data-unavailable={unavailable || undefined}
                  disabled={unavailable}
                  onClick={() => onPick(operation)}
                >
                  <span className={styles.glyph}>
                    <OperationGlyph symbol={operation.symbol} />
                  </span>
                  <span className={styles.text}>
                    <span className={styles.name}>{operation.label}</span>
                    <span className={styles.blurb}>{operation.blurb}</span>
                  {/* **Shown, not hidden.** An operation this instance cannot
                      run stays in the list with the reason under it: a user
                      looking for geocoding needs to learn that it exists and
                      what their instance is missing, not that it is absent. */}
                    {unavailable && operation.availability?.reason && (
                      <span
                        className={styles.unavailable}
                        data-operation-unavailable={operation.id}
                      >
                        {operation.availability.reason}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}
