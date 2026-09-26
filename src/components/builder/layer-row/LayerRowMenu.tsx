"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, MenuItem } from "../../ui/Menu";
import {
  ChevronIcon,
  CodeIcon,
  CopyIcon,
  MoreIcon,
  PencilIcon,
  TrashIcon,
} from "../../ui/icons";
import { IconDownload } from "../../gallery-icons";
import { LAYER_EXPORT_FORMATS } from "../export/formats";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import styles from "../LayerList.module.css";

interface Actions {
  layerId: string;
  layerName: string;
  onEditSource: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** This layer is a sketch's provenance-named owner — deleting it
   * deletes the drawn dataset too, and the confirm names both objects.
   * Copies and other layers keep the ordinary wording. */
  cascade?: boolean;
  /** The dataset the cascade destroys, named in the confirm. */
  cascadeDataset?: string;
  layerDataDownloads: LayerDataDownloadPort;
}

/** Every row leads with a mark (field round): one glyph reads
 * faster than a word, and the marks are the icons the same actions wore
 * when they lived on the row itself. */
function Mark({ children }: { children: React.ReactNode }) {
  return (
    <span className={styles.menuIco} aria-hidden>
      {children}
    </span>
  );
}

/**
 * The menu's contents, as their own component so the confirm state lives
 * and dies with the open menu — the kit renders children only while open,
 * so closing and reopening always starts from the plain list.
 */
function Body({
  layerId,
  layerName,
  onEditSource,
  onRename,
  onDuplicate,
  onDelete,
  cascade,
  cascadeDataset,
  layerDataDownloads,
}: Actions) {
  const [confirm, setConfirm] = useState<"duplicate" | "delete" | null>(null);
  // The three formats fold behind one Export row (field round:
  // three of the menu's eight seats went to variants of one action). The
  // rail they open on is the header export menu's own gesture — Data
  // there, Export data here, the same fold both times.
  const [exportsOpen, setExportsOpen] = useState(false);
  const bodyRef = useRef<HTMLSpanElement>(null);

  // Swapping the body unmounts the item that was focused, and `keepOpen`
  // deliberately skips the close that would otherwise hand focus back to
  // the trigger — so without this a keyboard opening loses focus to the
  // document and the arrow keys stop reaching the confirm.
  useEffect(() => {
    if (confirm === null) return;
    const first = bodyRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [confirm]);

  // Both confirms survive the move from the row into the menu, as menu
  // states rather than inline icon pairs: a destructive action still takes
  // a second, deliberate press.
  if (confirm === "delete") {
    return (
      <span ref={bodyRef} role="none" className={styles.menuBody}>
        <MenuItem danger onSelect={onDelete}>
          {cascade
            ? `Delete “${layerName}” and ${cascadeDataset ?? "its drawn dataset"}`
            : "Confirm delete"}
        </MenuItem>
        <MenuItem keepOpen onSelect={() => setConfirm(null)}>
          Cancel
        </MenuItem>
      </span>
    );
  }
  if (confirm === "duplicate") {
    return (
      <span ref={bodyRef} role="none" className={styles.menuBody}>
        <MenuItem onSelect={onDuplicate}>Create a copy</MenuItem>
        <MenuItem keepOpen onSelect={() => setConfirm(null)}>
          Cancel
        </MenuItem>
      </span>
    );
  }
  return (
    <span ref={bodyRef} role="none" className={styles.menuBody}>
      <MenuItem onSelect={onEditSource}>
        <Mark>
          <CodeIcon />
        </Mark>
        <span className={styles.menuLabel}>Edit source</span>
      </MenuItem>
      <MenuItem onSelect={onRename}>
        <Mark>
          <PencilIcon />
        </Mark>
        <span className={styles.menuLabel}>Rename</span>
      </MenuItem>
      <MenuItem keepOpen onSelect={() => setConfirm("duplicate")}>
        <Mark>
          <CopyIcon />
        </Mark>
        <span className={styles.menuLabel}>Duplicate</span>
      </MenuItem>
      {/* A group, not loose rows — the kit's menus expect items, groups or
          separators, and the door and its formats are one thing. */}
      <div role="group" aria-label="Export this layer's data">
        <MenuItem
          keepOpen
          expanded={exportsOpen}
          onSelect={() => setExportsOpen((open) => !open)}
        >
          <Mark>
            <IconDownload />
          </Mark>
          <span className={styles.menuLabel}>Export data</span>
          <span
            className={styles.menuChevron}
            data-open={exportsOpen || undefined}
            aria-hidden
          >
            <ChevronIcon />
          </span>
        </MenuItem>
        {exportsOpen && (
          <div className={styles.exportRail}>
            {LAYER_EXPORT_FORMATS.map((f) => (
              <MenuItem
                key={f.format}
                onSelect={() =>
                  layerDataDownloads.start(layerId, f.format)
                }
                disabled={layerDataDownloads.active(layerId, f.format)}
              >
                {f.label} <small>{f.hint}</small>
              </MenuItem>
            ))}
          </div>
        )}
      </div>
      <MenuItem danger keepOpen onSelect={() => setConfirm("delete")}>
        <Mark>
          <TrashIcon />
        </Mark>
        <span className={styles.menuLabel}>
          {cascade ? "Delete layer + dataset…" : "Delete layer"}
        </span>
      </MenuItem>
    </span>
  );
}

/**
 * A layer row's overflow menu (at field call).
 *
 * The row keeps only what it needs at rest — visibility and zoom-to-layer —
 * and everything else lives behind one door. The feature first shipped six
 * icons revealed over the card's trailing edge on hover; that read worse
 * in the field, and this replaces it. Nothing about a layer
 * row appears or disappears on hover now.
 */
export function LayerRowMenu(props: Actions) {
  return (
    <Menu
      className={styles.menuWrap}
      label={`Layer menu for ${props.layerName}`}
      triggerLabel="Layer menu"
      triggerClassName={styles.iconBtn}
      triggerProps={{ "data-hint": "More actions" }}
      trigger={<MoreIcon />}
      menuClassName={styles.menu}
      // A card starts a drag from any pointer press outside an input or a
      // data-no-dnd subtree; without this the trigger drags the row.
      data-no-dnd
    >
      <Body {...props} />
    </Menu>
  );
}
