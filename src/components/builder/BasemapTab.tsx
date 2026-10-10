"use client";

import { SINGLE_MAP_STYLES_OFF, type BasemapKey, type BasemapStyle } from "@/lib/basemap";
import { withGroupVisibility, type BasemapLayerGroup } from "@/lib/basemap-layers";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { BasemapPanel } from "./BasemapPanel";
import { takenCopy, useLibraryStyles } from "./use-library-styles";

/**
 * The inspector's Basemap tab wiring (at-touch slice from MapBuilder):
 * every panel affordance is a PATCH the lane owns — the pick, the
 * custom style's save/remove, and the group toggles, whose bodies build
 * from server truth at their turn so rapid toggles compose. A style the
 * instance's library offers is taken by its id: the server copies it onto
 * the map, and the builder holds that copy from the click on, so it draws
 * the style and its credit as a reload would; a pasted style likewise, its
 * copy built from the check the door made. Every request the lane draws
 * before the answer holds what the server stores, so a lost answer is
 * confirmed by the map read back. While single maps take only the
 * library's styles, the paste control is drawn disabled with the rule's
 * sentence, for everyone.
 */
export function BasemapTab({
  map,
  loadedGroups,
  overridden,
  basemaps,
  patchMap,
  statusPillVisible,
  onToggleStatusPill,
}: {
  map: MapWithLayers;
  /** Which groups the loaded style yields; consulted for custom only. */
  loadedGroups: BasemapLayerGroup[] | null;
  overridden: boolean;
  /** The styles this instance offers, server-injected. */
  basemaps?: BasemapStyle[];
  patchMap: (
    request:
      | Record<string, unknown>
      | ((current: MapWithLayers | null) => Record<string, unknown>),
    opts?: { sends?: Record<string, unknown> },
  ) => Promise<boolean>;
  statusPillVisible: boolean;
  onToggleStatusPill: (visible: boolean) => void;
}) {
  const library = useLibraryStyles();
  return (
    <BasemapPanel
      active={map.basemap}
      custom={map.customBasemap}
      libraryStyles={library.offered}
      pasteRefusal={library.singleMapStyles ? null : SINGLE_MAP_STYLES_OFF}
      onPickLibrary={(id) => {
        const style = library.offered.find((s) => s.id === id);
        if (style) void patchMap({ customBasemap: takenCopy(style) }, { sends: { customBasemap: { libraryStyle: id } } });
      }}
      onSaveCustom={(copy, sends) => patchMap({ customBasemap: copy }, { sends: { customBasemap: sends } })}
      onRemoveCustom={() => void patchMap({ customBasemap: null })}
      groupsPresent={map.customBasemap ? loadedGroups : null}
      overridden={overridden}
      basemaps={basemaps}
      onPick={(key: BasemapKey | null) =>
        // Picking a card while a custom style is active is an explicit choice to leave it — cleared
        // in the same write, or the five cards would appear dead (custom always wins the
        // resolution).
        void patchMap(
          map.customBasemap
            ? { basemap: key, customBasemap: null }
            : { basemap: key },
        )
      }
      layerToggles={map.basemapLayers}
      onToggleGroup={(group, visible) =>
        // Built when its turn in the lane starts, from server truth: two
        // rapid toggles compose instead of the second reverting the
        // first. Kept as the server keeps it, hidden groups alone.
        void patchMap((current) => ({
          basemapLayers: withGroupVisibility(
            current ? current.basemapLayers : map.basemapLayers,
            group,
            visible,
          ),
        }))
      }
      statusPillVisible={statusPillVisible}
      onToggleStatusPill={onToggleStatusPill}
    />
  );
}
