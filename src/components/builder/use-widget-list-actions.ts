"use client";

import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { MapWidget } from "@/lib/widgets";
import type { RailTab } from "./builder-shell-state";
import type { WidgetFocus } from "./WidgetsTab";

type PatchMap = (request: Record<string, unknown>) => Promise<boolean>;

/** Reorder only the visible rail cards while hidden widgets keep their slots. */
export function reorderVisibleWidgets(
  widgets: readonly MapWidget[],
  visibleWidgets: readonly MapWidget[],
  visibleIds: readonly string[],
): MapWidget[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const visible = new Set(visibleWidgets.map((widget) => widget.id));
  const queue = [...visibleIds];
  return widgets.map((widget) =>
    visible.has(widget.id)
      ? (byId.get(queue.shift() ?? "") ?? widget)
      : widget,
  );
}

/** Widget-list mutations and rail navigation, extracted from MapBuilder as
 * one behavior-preserving handler cluster under the decomposition rule. */
export function useWidgetListActions({
  map,
  visibleWidgets,
  setMap,
  patchMap,
  truthSeqRef,
  mapFieldEditedAtRef,
  setTab,
  setWidgetFocus,
}: {
  map: MapWithLayers | null;
  visibleWidgets: readonly MapWidget[];
  setMap: Dispatch<SetStateAction<MapWithLayers | null>>;
  patchMap: PatchMap;
  truthSeqRef: RefObject<number>;
  mapFieldEditedAtRef: RefObject<
    Partial<Record<"widgets" | "layerOrder" | "legendOrder", number>>
  >;
  setTab: Dispatch<SetStateAction<RailTab>>;
  setWidgetFocus: Dispatch<SetStateAction<WidgetFocus | null>>;
}) {
  const apply = useCallback(
    (widgets: MapWidget[]) => {
      if (!map) return;
      // Never send a reference the map cannot resolve. A legacy orphan
      // converges to the swept state on the next edit.
      const resolvable = widgets.filter(
        (widget) =>
          widget.layerId === null ||
          map.layers.some((layer) => layer.id === widget.layerId),
      );
      // The optimistic list takes a ticket so an earlier map echo cannot
      // regress it while its write is queued.
      truthSeqRef.current += 1;
      mapFieldEditedAtRef.current.widgets = truthSeqRef.current;
      setMap((current) =>
        current ? { ...current, widgets: resolvable } : current,
      );
      void patchMap({ widgets: resolvable });
    },
    [map, mapFieldEditedAtRef, patchMap, setMap, truthSeqRef],
  );

  const reorderVisible = useCallback(
    (visibleIds: string[]) => {
      if (!map) return;
      apply(reorderVisibleWidgets(map.widgets, visibleWidgets, visibleIds));
    },
    [apply, map, visibleWidgets],
  );

  const openOptions = useCallback(
    (id: string) => {
      setTab("widgets");
      setWidgetFocus({ id, nonce: Date.now() });
    },
    [setTab, setWidgetFocus],
  );

  const remove = useCallback(
    (id: string) => {
      if (map) apply(map.widgets.filter((widget) => widget.id !== id));
    },
    [apply, map],
  );

  return { apply, reorderVisible, openOptions, remove };
}
