"use client";

import type { BasemapKey, BasemapStyle } from "@/lib/basemap";
import type { BasemapLayerGroup } from "@/lib/basemap-layers";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { BasemapPanel } from "./BasemapPanel";

/**
 * The inspector's Basemap tab wiring (at-touch slice from MapBuilder):
 * every panel affordance is a PATCH the lane owns — the pick, the
 * custom style's save/remove, and the group toggles, whose bodies build
 * from server truth at their turn so rapid toggles compose.
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
  ) => Promise<boolean>;
  statusPillVisible: boolean;
  onToggleStatusPill: (visible: boolean) => void;
}) {
  return (
    <BasemapPanel
      active={map.basemap}
      custom={map.customBasemap}
      onSaveCustom={(body) => patchMap({ customBasemap: body })}
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
        // first.
        void patchMap((current) => ({
          basemapLayers: {
            ...(current?.basemapLayers ?? map.basemapLayers),
            [group]: visible,
          },
        }))
      }
      statusPillVisible={statusPillVisible}
      onToggleStatusPill={onToggleStatusPill}
    />
  );
}
