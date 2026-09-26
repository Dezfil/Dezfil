"use client";

import { useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { LayerRenderData } from "@/lib/layer-service";
import { layerCount, layerKind, layerSwatch } from "@/lib/layer-summary";
import { IconDownload } from "../../gallery-icons";
import { Menu, MenuItem } from "../../ui/Menu";
import type { LayerDataDownloadPort } from "../use-layer-data-downloads";
import { LAYER_EXPORT_FORMATS } from "./formats";
import styles from "./ExportControl.module.css";

export const IMAGE_EXPORT_UNAVAILABLE_MESSAGE =
  "This view is too close to frame at this map width. Zoom out slightly, widen the map, or use fullscreen, then try again.";

/**
 * The builder's export door (redesigned as chosen prototype, "two
 * doors"): one control beside Publish opening two rich rows — *Image*
 * and *Data*.
 *
 * The drill-down is gone. Choosing Data opens the layer list **in
 * place**, underneath, with both rows still visible: no back step, no
 * replaced panel, and no wondering which of three screens you are on.
 * Each layer row carries what the old bare list did not — its colour,
 * what it draws, and how much of it — and pointing at it (or focusing
 * into it) slides a formats line open UNDER the name, so a file is two
 * steps from opening the menu. Design A of the format-reveal prototype
 * (field round): the earlier overlay landed the pills on top
 * of the name — the row you were pointing at lost its identity.
 *
 * The formats are menu items in their own right rather than buttons
 * inside one: a keyboard journey walks straight into them, which a
 * hover-only reveal could never offer.
 */

export function ExportControl({
  map,
  renders,
  chromeClassName,
  onExportImage,
  imageExportAvailable,
  layerDataDownloads,
}: {
  map: MapWithLayers;
  /** The builder's render records, for each row's "how much it draws" —
   * the map metadata alone does not know. */
  renders: Record<string, LayerRenderData | undefined>;
  /** The header's shared button treatment. */
  chromeClassName: string;
  /** Guarded card opening. */
  onExportImage?: () => boolean;
  /** Reads the live camera and canvas on each menu opening. */
  imageExportAvailable?: () => boolean;
  /** Shared native-stream download road for every builder data door. */
  layerDataDownloads: LayerDataDownloadPort;
}) {
  const [imageAvailable, setImageAvailable] = useState(false);
  const imageConfigured =
    onExportImage !== undefined && imageExportAvailable !== undefined;

  return (
    <Menu
      className={styles.wrap}
      label="Export"
      trigger={
        <>
          <IconDownload />
          <span>Export</span>
        </>
      }
      triggerClassName={chromeClassName}
      triggerProps={{ "data-hint": "Export image or data" }}
      onOpen={() =>
        setImageAvailable(imageConfigured && imageExportAvailable())
      }
      // Both classes on the PORTALED menu: `data-export-menu` rides the
      // trigger's wrapper, so a selector hung off it never matched the
      // menu it was meant to size.
      menuClassName={`${styles.menu} ${styles.exportMenu}`}
      data-export-menu=""
    >
      <MenuBody
        map={map}
        renders={renders}
        onExportImage={onExportImage}
        onImageRefused={() => setImageAvailable(false)}
        imageConfigured={imageConfigured}
        imageAvailable={imageAvailable}
        layerDataDownloads={layerDataDownloads}
      />
    </Menu>
  );
}

/** The doors and the list. The open state lives INSIDE the menu, so it
 * unmounts with it and every opening starts at the two-door root — the
 * lesson flow spec caught when a reopened menu showed last time's
 * screen. */
function MenuBody({
  map,
  renders,
  onExportImage,
  onImageRefused,
  imageConfigured,
  imageAvailable,
  layerDataDownloads,
}: {
  map: MapWithLayers;
  renders: Record<string, LayerRenderData | undefined>;
  onExportImage?: () => boolean;
  onImageRefused: () => void;
  imageConfigured: boolean;
  imageAvailable: boolean;
  layerDataDownloads: LayerDataDownloadPort;
}) {
  const [dataOpen, setDataOpen] = useState(false);

  return (
    <>
      {imageConfigured && (
        <MenuItem
          onSelect={() => {
            const opened = onExportImage?.() ?? false;
            if (!opened) onImageRefused();
            return opened;
          }}
          className={styles.door}
          disabled={!imageAvailable}
        >
          <span className={styles.doorTile} aria-hidden>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <circle cx="5.7" cy="6.4" r="1.15" />
              <path d="M4 12.2l3.1-3.4 2.1 2.1 2-2.3 2.5 3.4" />
            </svg>
          </span>
          <span className={styles.doorText}>
            <b>Image</b>
            <small>
              {imageAvailable
                ? "A picture of this map, as a PNG"
                : IMAGE_EXPORT_UNAVAILABLE_MESSAGE}
            </small>
          </span>
        </MenuItem>
      )}
      {/* A group, not loose rows: `menu` children must be items, groups
          or separators, and the Data door is a label for what follows
          rather than a control of its own. */}
      {map.layers.length > 0 && (
        <div role="group" aria-label="Layer data">
          <MenuItem
            className={styles.door}
            onSelect={() => setDataOpen((open) => !open)}
            keepOpen
            expanded={dataOpen}
          >
            <span className={styles.doorTile} aria-hidden>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <ellipse cx="8" cy="4" rx="5.2" ry="2" />
                <path d="M2.8 4v8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V4" />
                <path d="M2.8 8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2" />
              </svg>
            </span>
            <span className={styles.doorText}>
              <b>Data</b>
              <small>A layer&apos;s result as a file</small>
            </span>
            <span
              className={styles.doorChevron}
              data-open={dataOpen || undefined}
              aria-hidden
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 3.5L10.5 8 6 12.5" />
              </svg>
            </span>
          </MenuItem>
          {dataOpen && (
            <div className={styles.layerList}>
              {/* Draw order is bottom-up; show top layer first — the panel's
                  own sort, so the two lists read as one (field find,
                  2026-08-10). */}
              {[...map.layers].reverse().map((layer) => {
                const render = renders[layer.id];
                const kind = layerKind(layer.viz, render);
                // The panel spine's colors and rendering, exactly — one
 // function, real stacked segments (a field find:
                // this row blended its own capped reading of the stored
                // style, so a hexbin's bar matched nothing on the map).
                const swatch = layerSwatch(layer.style, layer.viz, render);
                const count = layerCount(layer.viz, render);
                return (
                  <div key={layer.id} className={styles.layerRow}>
                    <span className={styles.layerTop}>
                      <span className={styles.swatch} aria-hidden>
                        {swatch.colors.map((c, i) => (
                          <i key={i} style={{ background: c }} />
                        ))}
                      </span>
                      <span className={styles.layerWho}>
                        <span className={styles.layerName}>{layer.name}</span>
                        <span className={styles.layerMeta}>
                          {kind}
                          {count ? ` · ${count}` : ""}
                        </span>
                      </span>
                    </span>
                    <span className={styles.formats}>
                      <span className={styles.formatsIn}>
                        {LAYER_EXPORT_FORMATS.map((f) => (
                          <MenuItem
                            key={f.format}
                            className={styles.format}
                            onSelect={() =>
                              layerDataDownloads.start(layer.id, f.format)
                            }
                            disabled={layerDataDownloads.active(
                              layer.id,
                              f.format,
                            )}
                            title={`${layer.name} · ${f.hint}`}
                          >
                            {f.label}
                          </MenuItem>
                        ))}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
