"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TableListing } from "./api";
import { cardDeletes, landAfterRemoval } from "./card-focus";
import { DeleteTableDialog } from "./DeleteTableDialog";

/**
 * A list's table delete: the dialog that asks first, and where focus goes
 * once the deleted item has left the list.
 *
 * The dialog hands focus back to the button that opened it, and that
 * button left with its item. So when a delete succeeds, the page's deletes
 * are noted as they stand, the list removes the item, and once the list has
 * redrawn without it focus moves to the next item's delete, else the
 * previous one's, else the list's heading.
 */
export function useTableDelete(onRemoved: (table: TableListing) => void): {
  /** Open the dialog for a table, from the button pressed. */
  ask: (table: TableListing, opener: HTMLElement) => void;
  /** The dialog while it is open. */
  dialog: ReactNode;
} {
  const [asking, setAsking] = useState<{ table: TableListing; opener: HTMLElement } | null>(null);
  const landing = useRef<{ opener: HTMLElement; peers: HTMLElement[] } | null>(null);

  useEffect(() => {
    const pending = landing.current;
    if (!pending || asking) return;
    landing.current = null;
    if (!pending.opener.isConnected) landAfterRemoval(pending.opener, pending.peers);
  }, [asking]);

  const ask = useCallback((table: TableListing, opener: HTMLElement) => setAsking({ table, opener }), []);

  const dialog = asking && (
    <DeleteTableDialog
      table={{ id: asking.table.id, name: asking.table.name, rowCount: asking.table.rowCount }}
      onClose={() => setAsking(null)}
      onDeleted={() => {
        landing.current = { opener: asking.opener, peers: cardDeletes() };
        onRemoved(asking.table);
        setAsking(null);
      }}
    />
  );

  return { ask, dialog };
}
