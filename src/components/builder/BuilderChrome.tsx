"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { contributePath, releasePath } from "@/components/shell/path-model";
import { useHeaderReach } from "@/components/shell/use-header-reach";
import { createPortal } from "react-dom";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { HistoryAvailability } from "@/lib/metadata/history";
import { IconButton } from "../ui/IconButton";
import { UndoIcon, RedoIcon, PreviewIcon } from "../ui/icons";
import { AssistantDoor, type AssistantDoorProps } from "./assistant/AssistantDoor";
import { PublishControl } from "./publish/PublishControl";
import type { LayerRenderData } from "@/lib/layer-service";
import { ExportControl } from "./export/ExportControl";
import type { LayerDataDownloadPort } from "./use-layer-data-downloads";
import { PathOwnerMark } from "../sharing/PeopleMarks";
import type { PersonLabel } from "../sharing/people";
import styles from "./MapBuilder.module.css";

/** The builder's fixed chrome, out of MapBuilder (the
 * decomposition habit's at-touch slice): the header contributions. The
 * assistant surface moved on to its own module —
 * `assistant/AssistantShell.tsx`. */

const subscribeNever = () => () => {};

/**
 * The builder's header contributions: the shell owns the header DOM; the
 * builder portals its breadcrumb tail (the bold, inline-editable map name)
 * and its action set into the shell's slot elements.
 *
 * The card carries the path and nothing else: the saving indication and the
 * notice channel moved to the stage's own chip, and with them the width the
 * card reserved for text nobody could see.
 */
export function HeaderChrome({
  map,
  projectId,
  history,
  onUndo,
  onRedo,
  onRename,
  assistant,
  onPublishChange,
  onExportImage,
  imageExportAvailable,
  renders,
  layerDataDownloads,
}: {
  map: MapWithLayers;
  /** The map's project; the shell's path reads it. */
  projectId: string | null;
  history: HistoryAvailability;
  onUndo: () => void;
  onRedo: () => void;
  onRename: (name: string) => void;
  /** The assistant's door: rendered here, in the ordered
   * action group, at the position Fit to data vacated. */
  assistant: AssistantDoorProps;
  onPublishChange: () => void;
  /** Opens the export image card through its independent framing guard. */
  onExportImage?: () => boolean;
  /** Rechecks image framing from the live camera/canvas when Export opens. */
  imageExportAvailable?: () => boolean;
  /** The builder's render records, so the export menu's layer rows
   * can say how much each layer draws. */
  renders: Record<string, LayerRenderData | undefined>;
  layerDataDownloads: LayerDataDownloadPort;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(map.name);
  // Escape abandons a rename in progress; the blur that follows must not
  // commit the draft (found during verification).
  const renameCancelled = useRef(false);

  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  const pathname = usePathname();
  // The shell's path model: the builder contributes its name and
  // membership; the title and the project segment follow.
  useEffect(() => {
    contributePath(pathname, { name: map.name, projectId });
    return () => releasePath(pathname);
  }, [pathname, map.name, projectId]);

  // The header card reaches at least the layer pane's right edge:
  // measured from the pane itself, released when the builder leaves.
  useHeaderReach(() =>
    document.querySelector<HTMLElement>("[data-builder-pane]"),
  );

  const viewUrl = map.publishToken ? `/v/${map.publishToken}` : null;

  if (!mounted) return null;
  // The shell header owns the slot DOM; it exists once the layout mounted.
  const crumbSlot = document.getElementById("header-crumb-slot");
  const leftSlot = document.getElementById("header-actions-left");
  const rightSlot = document.getElementById("header-actions-right");
  if (!crumbSlot || !leftSlot || !rightSlot) return null;

  const crumbTail = (
    <span className={styles.crumbTail}>
      <span className={styles.crumbSep}>/</span>
      {editing ? (
        <input
          className={styles.nameInput}
          value={value}
          autoFocus
          aria-label="Map name"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (!renameCancelled.current && value.trim()) {
              onRename(value.trim());
            }
            renameCancelled.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              renameCancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className={styles.name}
          /* **The name, then what clicking does**. The button truncates
             — at 300 px always, and sooner now that the header card yields
             before the actions do — so the tooltip has to be able to say what
             was cut off. A tooltip that only said "Rename map" left a
             truncated name with nowhere to be read in full. */
          title={`Rename ${map.name}`}
          onClick={() => {
            setValue(map.name);
            setEditing(true);
          }}
        >
          {map.name}
        </button>
      )}
      <PathOwnerMark owner={(map as { owner?: PersonLabel }).owner} />
    </span>
  );

  const leftActions = (
    <>
      <IconButton
        className={`${styles.chromeBtn} ${styles.iconBtn}`}
        tone="chrome"
        hint
        action="Undo"
        shortcut="⌘Z / Ctrl+Z"
        icon={<UndoIcon />}
        onClick={onUndo}
        disabled={!history.canUndo}
      />
      <IconButton
        className={`${styles.chromeBtn} ${styles.iconBtn}`}
        tone="chrome"
        hint
        action="Redo"
        shortcut="⇧⌘Z / Ctrl+Y"
        icon={<RedoIcon />}
        onClick={onRedo}
        disabled={!history.canRedo}
      />
      <AssistantDoor {...assistant} className={styles.chromeBtn} />
      {viewUrl && (
        <a
          className={styles.chromeBtn}
          href={viewUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Preview"
          data-hint="Preview"
        >
          <PreviewIcon />
          <span>Preview</span>
        </a>
      )}
    </>
  );

  const rightActions = (
    <>
      {/* Export beside Publish: "take something out" and "share
          something live" stay separate controls. */}
      <ExportControl
        map={map}
        renders={renders}
        chromeClassName={styles.chromeBtn}
        onExportImage={onExportImage}
        imageExportAvailable={imageExportAvailable}
        layerDataDownloads={layerDataDownloads}
      />
      <PublishControl map={map} onChange={onPublishChange} />
    </>
  );

  return (
    <>
      {createPortal(crumbTail, crumbSlot)}
      {createPortal(leftActions, leftSlot)}
      {createPortal(rightActions, rightSlot)}
    </>
  );
}
