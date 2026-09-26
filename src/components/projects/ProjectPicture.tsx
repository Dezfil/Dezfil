"use client";

import { MapStrip } from "../MapStrip";
import { WorkflowThumb } from "../WorkflowThumb";
import { IconData, IconFolder, IconMap, IconWorkflow } from "../gallery-icons";
import type { PictureItem } from "./model";
import styles from "./ProjectPicture.module.css";

/**
 * A project's one picture (kinds): its maps, then its workflows, four
 * at most — datasets take no tile — laid out by how many there are.
 * Four or more make the 2×2; three make one tall tile and two small;
 * two make halves; one fills; none is the quiet folder tile. A map tile
 * is the shipped map strip (placeholder under the snapshot), a workflow
 * tile the shipped miniature. On a card every tile carries its kind
 * mark; the row picture, too small for one, carries none.
 */

export const KIND_WORDS = {
  map: "Map",
  workflow: "Workflow",
  dataset: "Dataset",
} as const;

/** The kinds the icon and the words name: the picture's two and the
 * dataset the facts line, the recent rows and the picker still show. */
export type Kind = keyof typeof KIND_WORDS;

function itemId(item: PictureItem): string {
  return item.kind === "map" ? item.map.id : item.workflow.id;
}

export function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "map") return <IconMap />;
  if (kind === "workflow") return <IconWorkflow />;
  return <IconData />;
}

export function ProjectPicture({
  items,
  size,
  groupOf,
}: {
  items: PictureItem[];
  size: "card" | "row";
  groupOf: (operation: string) => string | null;
}) {
  const tiles = items.slice(0, 4);
  return (
    <span
      className={styles.picture}
      data-picture
      data-n={tiles.length}
      data-size={size}
    >
      {tiles.length === 0 ? (
        <span className={styles.tile} data-tile data-empty>
          <IconFolder />
        </span>
      ) : (
        tiles.map((item) => (
          <span
            key={`${item.kind}-${itemId(item)}`}
            className={styles.tile}
            data-tile
            data-kind={item.kind}
            data-id={itemId(item)}
          >
            <span className={styles.art}>
              {item.kind === "map" ? (
                <MapStrip map={item.map} />
              ) : (
                <WorkflowThumb
                  steps={item.workflow.steps}
                  groupOf={groupOf}
                  compact={size === "row"}
                />
              )}
            </span>
            {size === "card" && (
              <span
                className={styles.mark}
                data-mark
                title={KIND_WORDS[item.kind]}
                aria-label={KIND_WORDS[item.kind]}
              >
                <KindIcon kind={item.kind} />
              </span>
            )}
          </span>
        ))
      )}
    </span>
  );
}
