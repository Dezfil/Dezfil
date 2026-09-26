"use client";

import type { TableListing } from "../../api";
import { CatalogTableBrowser } from "./CatalogTableBrowser";
import type { CatalogListing } from "./use-catalog-tables";
import { Button } from "../../ui/Button";
import { ErrorNote } from "../../ui/ErrorNote";
import { canSetGeometry } from "../../set-geometry/eligibility";
import styles from "./AddLayerCatalog.module.css";

interface Props {
  listing: CatalogListing;
  picked: TableListing | null;
  onPick: (table: TableListing) => void;
  name: string;
  onName: (value: string) => void;
  busy: boolean;
  error: string | null;
  onDismissError?: () => void;
  onCreate: () => void;
  /** The non-spatial note's door (04): leaves the builder for the
   * dataset page with the set-geometry panel open. Given only where the
   * picked table's source is one the API accepts. */
  onSetGeometry?: (table: TableListing) => void;
}

/**
 * The catalog's tables source (quieted): the shared browser over the
 * live listing, and nothing else on pick — the row already carries
 * geometry, rows and size. The one survivor of the old detail strip is
 * the non-spatial explanation, because the submit stays disabled and
 * the reason must be visible. The footer is the constant anchor across
 * the browser's tri-state (the invariant rides the view: without a
 * visible pick the submit is disabled, so a retained selection can
 * never ride invisibly into a create).
 */
export function CatalogTablesView({
  listing,
  picked,
  onPick,
  name,
  onName,
  busy,
  error,
  onDismissError,
  onCreate,
  onSetGeometry,
}: Props) {
  const spatial = picked !== null && picked.geometryColumn !== null;

  return (
    <div className={styles.tablesView}>
      <CatalogTableBrowser
        listing={listing}
        selected={picked?.name ?? null}
        onPick={onPick}
      />

      {picked !== null && !spatial && (
        <p className={styles.nonspatialNote}>
          No geometry column. Still usable in the SQL source.
          {onSetGeometry && canSetGeometry(picked) && (
            <button
              type="button"
              className={styles.noteDoor}
              onClick={() => onSetGeometry(picked)}
              data-set-geometry-door="catalog"
            >
              Set geometry
            </button>
          )}
        </p>
      )}

      <footer className={styles.foot}>
        <label className={styles.nameField}>
          <span>Layer name</span>
          <input
            value={name}
            placeholder="Layer name"
            onChange={(e) => onName(e.target.value)}
          />
        </label>
        <Button
          variant="primary"
          className={styles.primaryBtn}
          busy={busy}
          disabled={picked === null || !spatial}
          onClick={onCreate}
        >
          {busy ? "Adding…" : "Add layer"}
        </Button>
      </footer>
      {error !== null && (
        <ErrorNote message={error} onDismiss={onDismissError} />
      )}
    </div>
  );
}
