"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { DrawerContents } from "./DrawerContents";
import { RecipeDrawer } from "./RecipeDrawer";
import { ToolsControlPortal } from "./ToolsControl";
import { useAuthorStep } from "./use-author-step";
import {
  useRecipeDrawer,
  type RecipeDrawerState,
} from "./use-recipe-drawer";
import { registerNotesReload, useRecipeNotePublisher } from "./recipe-notes";
import { useRecipes } from "./use-recipes";
import { useOperations } from "./use-operations";
import { useWorkspaceTables } from "./use-workspace-tables";
import { useStageEdges, type StageEdges } from "../use-stage-edge";
import { useHelperSlot, type HelperSlotControl } from "../use-helper-slot";

/**
 * The helpers' composition, kept out of the builder (two-sided): the
 * drawer left of the stage, the assistant right of it, the slot's rules
 * between them, and the two stage edges the camera frames against, read
 * as one commit. Composing them here is what keeps `MapBuilder.tsx` from
 * growing a third concern — and the decomposition rule from failing the
 * build, which is how this module came to exist.
 */
export function useBuilderStage(): {
  drawer: RecipeDrawerState;
  slot: HelperSlotControl;
  stageEdges: StageEdges;
} {
  // The drawer's doors report a hand open to the slot; the slot decides
  // what that does to the assistant (a replacement below the limit, a
  // neighbour above it), in the same event, so the slot never blinks.
  const onToolsOpenedRef = useRef<(() => void) | null>(null);
  const onDrawerOpen = useCallback(() => onToolsOpenedRef.current?.(), []);
  const drawer = useRecipeDrawer({ onOpen: onDrawerOpen });
  const slot = useHelperSlot(drawer, onToolsOpenedRef);

  // **Commits, not frames.** Both edges are one committed input: the key
  // moves once per open, close, replacement or band crossing, and a
  // replacement that moves both edges commits once.
  const stageEdges = useStageEdges(slot.committedAt);
  return { drawer, slot, stageEdges };
}

/** The drawer as the builder mounts it: between the inspector and the stage,
 * with the recipe index in the topbar beside it. */
export function RecipeDrawerHost({
  state,
  map,
  selectedLayerId,
  onWorkspaceChange,
  onLayerMade,
  hidden = false,
}: {
  state: RecipeDrawerState;
  /** The map being built; null before it has loaded. */
  map: MapWithLayers | null;
  /**
   * A run changed the workspace, so the builder should read it again.
   *
   * Without this a result asked onto the map appears in the API and not on the
   * screen: the builder holds the map it loaded, and a new layer — or a
   * re-run's replaced output under an existing layer — waits for a page
   * reload. Found at the cross-model review, and the browser check that missed
   * it was polling the API rather than the builder.
   */
  onWorkspaceChange: () => void;
  /** The builder's selected layer — the Tools door's context:
   * opening Tools with a selection behaves as the card door did, suggested
   * group first and the input pre-filled. */
  selectedLayerId?: string | null;
  /** A run created this layer, and the builder selects it. */
  onLayerMade?: (layerId: string) => void;
  /** The width hid the drawer: mounted and out of
   * sight, its form kept, until the width brings it back. */
  hidden?: boolean;
}) {
  const recipes = useRecipes();
  const tables = useWorkspaceTables();
  const { operations } = useOperations();
  const labels = useMemo(
    () =>
      Object.fromEntries((operations ?? []).map((o) => [o.id, o.label])),
    [operations],
  );
  const settled = useCallback(() => {
    recipes.reload();
    tables.reload();
    onWorkspaceChange();
  }, [recipes, tables, onWorkspaceChange]);
 // **Fresh at the moment of use** (a sitting fix): the list loads
  // with the builder and reloads when a run settles — so a table that arrived
  // any other way (an upload foremost) was invisible to the picker and to the
  // door's pre-fill until a full page reload. Opening Tools is the moment the
  // list is about to be read; both derivations are reactive, so the refusal
  // sentence heals itself the moment the fresh answer lands.
  useEffect(() => {
    if (!state.open) return;
    tables.reload();
    recipes.reload();
    // The port identities are stable across renders; keying on them too
    // would make any unrelated re-render re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open]);
  // The strip's Re-run settles outside the drawer and needs exactly this
  // settle; the store carries it so the card never threads through the
  // builder.
  useEffect(() => {
    registerNotesReload(settled);
    return () => registerNotesReload(null);
  }, [settled]);
  // The layer cards read their recipe's sentence from here: the drawer is the
  // one place that has both halves in hand, and threading them through the
  // builder would grow the module the decomposition rule protects.
  useRecipeNotePublisher(recipes.recipes, tables.tables, labels);
  // Lifted out of the contents so the collapsed strip's spinner sees it: the
  // first Add-step-and-run of a draft is an authoring run, and a strip that
  // showed nothing during it would be a live indicator that is not live.
  const authoring = useAuthorStep({ mapId: map?.id ?? "", onSettled: settled });
  const open = state.recipeId
    ? (recipes.recipes ?? []).find((r) => r.id === state.recipeId)
    : undefined;

  return (
    <>
      {/* The Tools door lives in the topbar and does not need the
          drawer open — it is how the drawer opens. It replaced the
          recipe index at the cutover. */}
      <ToolsControlPortal state={state} selectedLayerId={selectedLayerId ?? null} hidden={hidden} />
      <RecipeDrawer state={state} name="Tools" onDismiss={state.close} hidden={hidden}>
        {map && (
          <DrawerContents
            // **Keyed by the authoring session, not by the recipe id.**
            // Opening another recipe, or pressing Analyze on another layer,
            // starts a session and the contents begin again. Keying on the
            // recipe id instead reset them mid-run, the moment a draft's first
            // run learned its own id — discarding the notice that run was
            // about to deliver.
            key={state.session}
            state={state}
            recipe={open}
            recipes={recipes}
            tables={tables}
            mapId={map.id}
            authoring={authoring}
            layers={map.layers}
            onFreshAction={state.newRecipe}
            onDone={state.close}
            onLayerMade={onLayerMade}
          />
        )}
      </RecipeDrawer>
    </>
  );
}
