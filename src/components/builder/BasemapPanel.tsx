"use client";

import {
  BASEMAPS,
  offeredOnly,
  type BasemapKey,
  type BasemapStyle,
  type LibraryStyleOffer,
} from "@/lib/basemap";
import {
  BASEMAP_LAYER_GROUPS,
  BASEMAP_LAYER_GROUP_LABELS,
  type BasemapLayerGroup,
  type BasemapLayers,
} from "@/lib/basemap-layers";
import type { CustomBasemap } from "@/lib/metadata/maps";
import { CustomBasemapSection } from "./CustomBasemapSection";
import { BasemapThumb } from "../map/BasemapThumb";
import { EyeIcon, EyeOffIcon, MapIcon } from "../ui/icons";
import { IconButton } from "../ui/IconButton";
import panel from "./panel.module.css";
import styles from "./BasemapPanel.module.css";

interface Props {
  /** The map's explicit choice; null = Auto (follows the app theme). */
  active: BasemapKey | null;
  /** The map's custom style; null = none. When set it wins
   * over the key and the built-in cards show unselected. */
  custom: CustomBasemap | null;
  onSaveCustom: (body: {
    url: string;
    name: string | null;
    force?: boolean;
  }) => Promise<boolean>;
  onRemoveCustom: () => void;
  /** Which groups the loaded style yields; null = unknown. */
  groupsPresent: BasemapLayerGroup[] | null;
  /** Deployment override set (DEZFIL_BASEMAP_URL) — pins Auto. */
  overridden: boolean;
  /** The styles this instance draws, server-injected, each marked
   * offered or not: only an offered one is a card, while the map's own
   * style keeps its kind for the group toggles. Imagery is configured
   * rather than shipped, so it is a card only where it is configured. */
  basemaps?: BasemapStyle[];
  onPick: (key: BasemapKey | null) => void;
  /** The styles the instance's library offers, after the built-in ones. */
  libraryStyles?: LibraryStyleOffer[];
  /** Take a library style: the map keeps its own copy of it. */
  onPickLibrary?: (id: string) => void;
  /** Hidden basemap content groups; null = all visible. */
  layerToggles: BasemapLayers | null;
  onToggleGroup: (group: BasemapLayerGroup, visible: boolean) => void;
  /** Builder status pill — a per-browser preference, not map state. */
  statusPillVisible: boolean;
  onToggleStatusPill: (visible: boolean) => void;
}

/**
 * Basemap picker (Auto): Auto follows the app theme — dark map in dark
 * mode, light in light mode — and is the default for new maps; three
 * explicit styles never change with the theme. The choice persists per map;
 * published views render explicit choices as chosen and Auto as the
 * deployment default. Below the picker, the map's basemap content groups —
 * each hideable with an eye toggle, on every style, in the builder and the
 * published view alike.
 */
export function BasemapPanel({
  active,
  custom,
  onSaveCustom,
  onRemoveCustom,
  groupsPresent,
  overridden,
  basemaps = BASEMAPS,
  onPick,
  libraryStyles = [],
  onPickLibrary = () => {},
  layerToggles,
  onToggleGroup,
  statusPillVisible,
  onToggleStatusPill,
}: Props) {
  // Group toggles act on vector styles only. A custom style reads as vector, but until it has
  // actually loaded and reported its content the groups are unknown — the section degrades inert
  // with one worded line rather than offering toggles that may move nothing.
  const customUnknown = custom !== null && groupsPresent === null;
  const groupsApply = custom
    ? !customUnknown
    : (basemaps.find((b) => b.key === active)?.kind ?? "vector") ===
      "vector";
  // A map's copy of a library style is marked on the library's card, not
  // drawn again as the map's own custom style.
  const fromLibrary = custom !== null && libraryStyles.some((s) => s.url === custom.url);
  return (
    <div className={styles.panel}>
      <div className={styles.grid}>
        <button
          type="button"
          className={styles.card}
          data-active={!custom && active === null}
          onClick={() => onPick(null)}
        >
          <BasemapThumb style="auto" />
          <span className={styles.label}>Auto</span>
        </button>
        {offeredOnly(basemaps).map((b) => (
          <button
            key={b.key}
            type="button"
            className={styles.card}
            data-active={!custom && b.key === active}
            onClick={() => onPick(b.key)}
          >
            <BasemapThumb style={b.key} />
            <span className={styles.label}>{b.label}</span>
          </button>
        ))}
        {libraryStyles.map((s) => (
          <button
            key={s.id}
            type="button"
            className={styles.card}
            data-active={custom?.url === s.url}
            onClick={() => onPickLibrary(s.id)}
          >
            <span className={styles.styleArt} aria-hidden>
              <MapIcon />
            </span>
            <span className={styles.label}>{s.name}</span>
          </button>
        ))}
        <CustomBasemapSection
          custom={fromLibrary ? null : custom}
          onSave={onSaveCustom}
          onRemove={onRemoveCustom}
        />
      </div>
      {custom && !fromLibrary ? (
        <p className={styles.note}>
          Remove it to return to the choice underneath.
        </p>
      ) : active === null && overridden ? (
        <p className={styles.note}>This deployment pins its own style.</p>
      ) : null}
      {/* The previews are captures of the styles themselves, and the
          map's footer only credits the style in use. */}
      <p className={styles.thumbCredit}>
        Previews: © OpenMapTiles, OpenStreetMap
      </p>
      <div className={styles.groupSection} data-inert={!groupsApply}>
        <h3 className={`${panel.sectionLabel} ${styles.groupTitle}`}>Map layers</h3>
        <ul className={styles.groupList}>
          {BASEMAP_LAYER_GROUPS.map((group) => {
            const visible = layerToggles?.[group] !== false;
            // With a custom style active, a group the loaded style does
            // not yield degrades honestly: marked, inert, the saved
            // toggle preserved for styles that do carry it.
            const absent =
              custom !== null &&
              groupsPresent !== null &&
              !groupsPresent.includes(group);
            return (
              <li
                key={group}
                className={styles.groupRow}
                data-off={!visible}
                data-absent={absent || undefined}
              >
                <span className={styles.groupLabel}>
                  {BASEMAP_LAYER_GROUP_LABELS[group]}
                  {absent && (
                    <span className={styles.groupAbsent}>
                      {" "}
                      · not in this style
                    </span>
                  )}
                </span>
                <IconButton
                  className={styles.groupEye}
                  tone={visible ? "accent" : "default"}
                  action={
                    absent
                      ? "Not in this style"
                      : customUnknown
                        ? "Waiting for the style"
                        : !groupsApply
                          ? "Vector styles only"
                          : visible
                          ? `Hide ${BASEMAP_LAYER_GROUP_LABELS[group].toLowerCase()}`
                          : `Show ${BASEMAP_LAYER_GROUP_LABELS[group].toLowerCase()}`
                  }
                  icon={visible ? <EyeIcon /> : <EyeOffIcon />}
                  aria-pressed={visible}
                  disabled={!groupsApply || absent}
                  onClick={() => onToggleGroup(group, !visible)}
                />
              </li>
            );
          })}
        </ul>
        {customUnknown || !groupsApply ? (
          <p className={styles.note}>Your saved choices are kept.</p>
        ) : null}
      </div>
      <div className={styles.groupSection}>
        <h3 className={`${panel.sectionLabel} ${styles.groupTitle}`}>Overlays</h3>
        <ul className={styles.groupList}>
          <li className={styles.groupRow} data-off={!statusPillVisible}>
            <span className={styles.groupLabel}>Status bar</span>
            <IconButton
              className={styles.groupEye}
              tone={statusPillVisible ? "accent" : "default"}
              action={
                statusPillVisible ? "Hide status bar" : "Show status bar"
              }
              icon={statusPillVisible ? <EyeIcon /> : <EyeOffIcon />}
              aria-pressed={statusPillVisible}
              onClick={() => onToggleStatusPill(!statusPillVisible)}
            />
          </li>
        </ul>
        <p className={styles.note}>Builder only.</p>
      </div>
    </div>
  );
}
