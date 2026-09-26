"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { geometryClient, type GeometryClient } from "./client";
import { CLOSED_STATE, createPanelController, type PanelController, type PanelState, type TableFacts } from "./panel-controller";
import type { GeometrySetResult, SeedChoice } from "./types";

/**
 * The dataset page's handle on the panel: one controller per dataset,
 * its state read through the external-store contract so a superseded
 * answer never paints out of order with React's own commits. The page's
 * hand-off is configured in an effect, so the controller is not rebuilt
 * on every render of the page, and the dataset's facts are read at the
 * moment a door opens the panel, so the page's re-read after an apply is
 * what the next open sees. The page holds it above its loading boundary,
 * so the controller outlives a re-read and the address opens once.
 */
export function useSetGeometryPanel({ name, table, onApplied, onOpen, client = geometryClient }: {
  name: string;
  table: TableFacts;
  onApplied: (result: GeometrySetResult) => void;
  onOpen?: () => void;
  client?: GeometryClient;
}): {
  state: PanelState;
  controller: PanelController;
  open: (seed?: SeedChoice | null, options?: { markProjection?: boolean }) => void;
  openByAddress: () => void;
} {
  const [initialOnOpen] = useState(() => onOpen);
  const controller = useMemo(() => createPanelController({ client, name, onOpen: initialOnOpen }), [client, name, initialOnOpen]);
  useEffect(() => {
    controller.configure({ onApplied, onOpen });
  }, [controller, onApplied, onOpen]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, () => CLOSED_STATE);
  const { geometryColumn, crsAssumed } = table;
  const open = useCallback(
    (seed: SeedChoice | null = null, options?: { markProjection?: boolean }) => void controller.open({ geometryColumn, crsAssumed }, seed, options),
    [controller, geometryColumn, crsAssumed],
  );
  const openByAddress = useCallback(
    () => void controller.openByAddress({ geometryColumn, crsAssumed }),
    [controller, geometryColumn, crsAssumed],
  );
  return { state, controller, open, openByAddress };
}
