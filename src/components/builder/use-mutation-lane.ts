"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";
import { readApiError } from "../api";
import type { LayerRenderData } from "./render-data";
import { layerContainsPatch, mapContainsPatch } from "./layer-patch";

/** Who raised a failure — and therefore who owns clearing it. */
export const FAILURE_LANES = [
  "load",
  "map",
  "layer",
  "history",
  "preview",
  // Fitting's own lane: asking the server for an extent can fail, and
  // that is not a mutation — borrowing the map lane would let a failed
  // camera move look like a failed save.
  "fit",
  // The published map's own lane. It has to be here rather than inside
  // the publish popover: the theme sync runs whenever a published map is
  // open, and the popover exists only while it is open — a failure raised
  // there would vanish with the dismissal.
  "publish",
] as const;
export type FailureLane = (typeof FAILURE_LANES)[number];
/** The static lanes plus one lane per layer (spec banners have
 * owners — success on one layer must not clear another layer's standing
 * failure). The bare "layer" lane remains the add-layer path's, which has
 * no id yet. */
export type FailureKey = FailureLane | `layer:${string}`;

/**
 * The mutation/recovery lane — kept beside MapBuilder instead of inside
 * it (the decomposition rule). Owns the ordered map-level
 * write lane and the per-layer ordering boundaries, the
 * verify-then-reconcile recovery on every uncertain outcome, newest-wins
 * per-object response application, the lane-owned dismissible failure
 * banners, and the pending-saves accounting behind the header's Saving…
 * whisper.
 *
 * The truth refs (tickets, before-image, epoch) stay declared in
 * useBuilderMutations and arrive here as parameters: the load effect and the
 * structural mutations (duplicate, delete, reorder, widget edits) take
 * tickets on the same counters, so those refs are genuinely shared state,
 * not lane internals.
 */
export function useMutationLane({
  mapId,
  map,
  setMap,
  rendersRef,
  authoritativeLayersRef,
  truthSeqRef,
  layerConfirmedAtRef,
  layerRemovedAtRef,
  mapFieldEditedAtRef,
  mapAppliedAtRef,
  serverMapRef,
  reloadEpochRef,
  refreshLayer,
  reload,
  edited,
  clearLegendLive,
}: {
  mapId: string;
  /** Current map state — the lane keeps the authoritative per-layer ref
   * in step with it (newest-wins). */
  map: MapWithLayers | null;
  setMap: Dispatch<SetStateAction<MapWithLayers | null>>;
  /** Layer render data by id — patchLayer consults it to decide whether
   * an edit reshapes a tiled archive's projection. */
  rendersRef: RefObject<Record<string, LayerRenderData>>;
  authoritativeLayersRef: RefObject<Record<string, Layer>>;
  truthSeqRef: RefObject<number>;
  layerConfirmedAtRef: RefObject<Record<string, number>>;
  layerRemovedAtRef: RefObject<Record<string, number>>;
  mapFieldEditedAtRef: RefObject<
    Partial<Record<"widgets" | "layerOrder" | "legendOrder", number>>
  >;
  mapAppliedAtRef: RefObject<number>;
  serverMapRef: RefObject<MapWithLayers | null>;
  reloadEpochRef: RefObject<number>;
  refreshLayer: (layerId: string) => Promise<void>;
  /** Whole-map resync — the recovery of last resort for structural
   * uncertainty. */
  reload: () => void;
  /** Any successful edit enables undo and clears redo. */
  edited: () => void;
  /** Discards a layer's in-progress Legend-tab text — a recovered read
   * is authoritative for it too. */
  clearLegendLive: (layerId: string) => void;
}) {
  // Failures are keyed by the lane that raised them. One shared string
  // meant nine writers and a single clearer, so "the layer save could
  // not be confirmed" outlived its condition until the user happened to
  // change the basemap. A lane clears its own message on its next
  // success; the reader can dismiss any of them.
  const [failures, setFailures] = useState<
    Partial<Record<FailureKey, string>>
  >({});
  const fail = useCallback((lane: FailureKey, message: string) => {
    setFailures((f) => ({ ...f, [lane]: message }));
  }, []);
  const clearFailure = useCallback((lane: FailureKey) => {
    setFailures((f) => {
      if (!(lane in f)) return f;
      const next = { ...f };
      delete next[lane];
      return next;
    });
  }, []);

  // Saved-state indicator: counts in-flight writes (top bar).
  const [pendingSaves, setPendingSaves] = useState(0);
  const track = useCallback(async <T>(work: Promise<T>): Promise<T> => {
    setPendingSaves((n) => n + 1);
    try {
      return await work;
    } finally {
      setPendingSaves((n) => n - 1);
    }
  }, []);

  // All durable mutations for one layer share an ordering boundary. Without
  // it, an uncertain response from one control could resync a stale layer
  // over a later accepted change from another control.
  const layerPatchQueueRef = useRef<Record<string, Promise<void>>>({});
  // Map-level mutations share one ordered lane per map: requests run
  // strictly in call order, so two in-flight saves can never resolve out of
  // order and revert each other. The camera deliberately bypasses this lane
  // — latest-wins, never queued.
  const mapPatchQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Every map-shaped response — save echoes, recovery reads, undo bodies —
  // lands through one application seam, so response discipline has a single
  // home.
  const applyMapResponse = useCallback(
    (
      body: MapWithLayers,
      changed: boolean,
      /** The counter's value when this response's request was sent.
       * `Infinity` marks a body that supersedes every lane — a reload or an
       * applied history step, authoritative for the whole map. */
      sentAt: number,
    ) => {
      if (sentAt === Infinity) {
        layerConfirmedAtRef.current = {};
        layerRemovedAtRef.current = {};
        mapFieldEditedAtRef.current = {};
        truthSeqRef.current += 1;
        reloadEpochRef.current += 1;
      }
      const layers = body.layers
        // A layer deleted after this response was sent must not return.
        .filter(
          (layer) => !((layerRemovedAtRef.current[layer.id] ?? -1) > sentAt),
        )
        .map((layer) => {
          const confirmedAt = layerConfirmedAtRef.current[layer.id];
          return confirmedAt !== undefined && confirmedAt > sentAt
            ? (authoritativeLayersRef.current[layer.id] ?? layer)
            : layer;
        });
      // A layer confirmed into existence after this response was sent
      // (a duplicate's copy) is absent from its embedded set — a stale
      // body must not remove it.
      for (const [id, confirmedAt] of Object.entries(
        layerConfirmedAtRef.current,
      )) {
        if (confirmedAt > sentAt && !layers.some((l) => l.id === id)) {
          const kept = authoritativeLayersRef.current[id];
          if (kept) layers.push(kept);
        }
      }
      mapAppliedAtRef.current = truthSeqRef.current;
      serverMapRef.current = { ...body, layers };
      setMap((current) => {
        let next = { ...body, layers };
        if (current) {
          // Map fields edited optimistically after this response was
          // sent keep the newer local value — their own echo is still in
          // the lane, and applying the older body would let a further
          // edit build from regressed state.
          if ((mapFieldEditedAtRef.current.widgets ?? -1) > sentAt) {
            next = { ...next, widgets: current.widgets };
          }
          if ((mapFieldEditedAtRef.current.layerOrder ?? -1) > sentAt) {
            const pos = new Map(current.layers.map((l, i) => [l.id, i]));
            next = {
              ...next,
              layers: [...next.layers].sort(
                (a, b) =>
                  (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                  (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              ),
            };
          }
          if ((mapFieldEditedAtRef.current.legendOrder ?? -1) > sentAt) {
            next = { ...next, legendOrder: current.legendOrder };
          }
        }
        return next;
      });
      if (changed) edited();
    },
    [
      authoritativeLayersRef,
      edited,
      layerConfirmedAtRef,
      layerRemovedAtRef,
      mapAppliedAtRef,
      mapFieldEditedAtRef,
      reloadEpochRef,
      serverMapRef,
      setMap,
      truthSeqRef,
    ],
  );

  // Keep the authoritative ref in step with map state for the paths that
  // set it directly (duplicate, delete, reorder, widget edits). It follows
  // the same newest-wins rule: a layer its own lane confirmed after this
  // map state was produced keeps the lane's version.
  useEffect(() => {
    if (!map) return;
    const appliedAt = mapAppliedAtRef.current;
    const next: Record<string, Layer> = {};
    for (const layer of map.layers) {
      const confirmedAt = layerConfirmedAtRef.current[layer.id];
      next[layer.id] =
        confirmedAt !== undefined && confirmedAt > appliedAt
          ? (authoritativeLayersRef.current[layer.id] ?? layer)
          : layer;
    }
    authoritativeLayersRef.current = next;
  }, [map, authoritativeLayersRef, layerConfirmedAtRef, mapAppliedAtRef]);

  const patchMap = useCallback(
    (
      request:
        | Record<string, unknown>
        | ((current: MapWithLayers | null) => Record<string, unknown>),
      opts: {
        /** A distinct history gesture: without a group, two
         * same-shape writes inside the server's coalescing window merge
         * into one step — a legend move followed quickly by its reset
         * would undo to nothing. */
        changeGroup?: string;
      } = {},
    ): Promise<boolean> => {
      const result = mapPatchQueueRef.current.then(async () => {
        // A queued whole-object body (basemap group toggles) built at call
        // time would be stale by its turn — the earlier queued edit already
        // landed. A thunk builds the body from server truth as the turn
        // starts, so queued edits compose instead of reverting each other.
        const body =
          typeof request === "function"
            ? request(serverMapRef.current)
            : request;
        // Taken inside the lane, immediately before the request goes out:
        // any layer confirmed after this point outranks what comes back.
        const sentAt = truthSeqRef.current;
        const epoch = reloadEpochRef.current;
        // Where a write may have landed, find out — never guess. The
        // authoritative re-read also heals optimistic state that ran ahead
        // of a refused request (the layer lane's recovery, generalized).
        const reconcile = async (uncertain: boolean): Promise<boolean> => {
          // When the truth read fails too — thrown or refused — the server
          // is effectively unreachable. Fall back to the last
          // server-confirmed state rather than leave optimistic edits
          // (widgets, order) standing as if accepted (rolled back or
          // reconciled, never guessed).
          const rollBack = () => {
            if (serverMapRef.current) {
              applyMapResponse(serverMapRef.current, false, sentAt);
            }
            return false;
          };
          try {
            const response = await fetch(`/api/maps/${mapId}`, {
              cache: "no-store",
            });
            if (!response.ok) return rollBack();
            const recovered = (await response.json()) as MapWithLayers;
            const accepted =
              uncertain &&
              mapContainsPatch(
                recovered as unknown as Record<string, unknown>,
                body,
              );
            applyMapResponse(recovered, accepted, sentAt);
            return accepted;
          } catch {
            return rollBack();
          }
        };
        const unconfirmed = (cause: unknown) =>
          fail(
            "map",
            `The map save could not be confirmed. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );

        let response: Response;
        try {
          response = await track(
            fetch(`/api/maps/${mapId}`, {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                ...(opts.changeGroup
                  ? { "X-Change-Group": opts.changeGroup }
                  : null),
              },
              body: JSON.stringify(body),
            }),
          );
        } catch (cause) {
          unconfirmed(cause);
          return reconcile(true);
        }
        if (!response.ok) {
          fail("map", await readApiError(response));
          return reconcile(false);
        }
        let updated: MapWithLayers;
        try {
          updated = (await response.json()) as MapWithLayers;
        } catch (cause) {
          unconfirmed(cause);
          return reconcile(true);
        }
        // A clean save clears this lane's standing failure — and only
        // this lane's.
        clearFailure("map");
        if (reloadEpochRef.current !== epoch) {
          // A whole-map resync (assistant turn, applied history step)
          // landed while this request was in flight: the echo is older
          // than the resync's truth and would revert it. Re-read instead
          // of applying (two writers converge).
          return reconcile(true);
        }
        applyMapResponse(updated, true, sentAt);
        return true;
      });
      mapPatchQueueRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [
      mapId,
      track,
      applyMapResponse,
      clearFailure,
      fail,
      reloadEpochRef,
      serverMapRef,
      truthSeqRef,
    ],
  );

  const syncAuthoritativeLayer = useCallback(
    (layer: Layer, changed: boolean) => {
      authoritativeLayersRef.current[layer.id] = layer;
      // This layer's own lane just spoke: no map response sent before now
      // may regress it.
      truthSeqRef.current += 1;
      layerConfirmedAtRef.current[layer.id] = truthSeqRef.current;
      if (serverMapRef.current) {
        serverMapRef.current = {
          ...serverMapRef.current,
          layers: serverMapRef.current.layers.map((candidate) =>
            candidate.id === layer.id ? layer : candidate,
          ),
        };
      }
      // A recovered read is authoritative too: discard any live text that was
      // waiting for the lost response rather than leaving it over stale state.
      clearLegendLive(layer.id);
      setMap((current) =>
        current
          ? {
              ...current,
              layers: current.layers.map((candidate) =>
                candidate.id === layer.id ? layer : candidate,
              ),
            }
          : current,
      );
      if (changed) edited();
    },
    [
      authoritativeLayersRef,
      clearLegendLive,
      edited,
      layerConfirmedAtRef,
      serverMapRef,
      setMap,
      truthSeqRef,
    ],
  );

  const patchLayer = useCallback(
    (
      layerId: string,
      body: Record<string, unknown>,
      opts: { skipRefresh?: boolean; separateHistoryStep?: boolean } = {},
    ): Promise<Layer | null> => {
      const before = layerPatchQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
        const epoch = reloadEpochRef.current;
        // Failures are owned per layer lane: a save that fails on one
        // layer must keep its banner through another layer's success.
        const lane = `layer:${layerId}` as const;
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        // Release-only controls already emit one write per gesture. Give that
        // write a unique group so the server's legacy rapid-write coalescer
        // cannot merge it with a preceding, separate interaction.
        if (opts.separateHistoryStep) {
          headers[CHANGE_GROUP_HEADER] = crypto.randomUUID();
        }
        const changesRender =
          body.sql !== undefined ||
          body.viz !== undefined ||
          body.filters !== undefined ||
          // On a tiled layer, interaction, published-field, and style
          // edits reshape the archive's projection — refetch so the
          // rebuild kicks and the canvas converges. Inline renders are
          // untouched by these fields.
          (rendersRef.current[layerId]?.tiles !== undefined &&
            (body.tooltip !== undefined ||
              body.popup !== undefined ||
              body.publishedFields !== undefined ||
              body.style !== undefined));
        const recover = async (cause: unknown): Promise<Layer | null> => {
          const detail =
            cause instanceof Error ? cause.message : "Network failure.";
          fail(lane, `The layer save could not be confirmed. ${detail}`);
          try {
            const response = await fetch(`/api/layers/${layerId}`, {
              cache: "no-store",
            });
            if (!response.ok) return null;
            const recovered = (await response.json()) as Layer;
            const accepted = layerContainsPatch(
              recovered as unknown as Record<string, unknown>,
              body,
            );
            syncAuthoritativeLayer(recovered, accepted);
            if (!opts.skipRefresh && changesRender) await refreshLayer(layerId);
            return accepted ? recovered : null;
          } catch {
            // The authoritative read is best-effort. Callers still receive a
            // failed outcome and unwind their preview to the last known layer.
            return null;
          }
        };

        let response: Response;
        try {
          response = await track(
            fetch(`/api/layers/${layerId}`, {
              method: "PATCH",
              headers,
              body: JSON.stringify(body),
            }),
          );
        } catch (error) {
          return recover(error);
        }
        if (!response.ok) {
          fail(lane, await readApiError(response));
          return null;
        }
        let updated: Layer;
        try {
          updated = (await response.json()) as Layer;
        } catch (error) {
          return recover(error);
        }
        // A confirmed layer save clears this lane's standing failure —
        // the coupling that made a stale banner wait for a basemap
        // change.
        clearFailure(lane);
        if (reloadEpochRef.current !== epoch) {
          // A whole-map resync landed while this save was in flight — for
          // this layer its truth may be newer than the echo. Re-read the
          // layer rather than apply a possibly stale body over it (two
          // writers converge).
          try {
            const fresh = await fetch(`/api/layers/${layerId}`, {
              cache: "no-store",
            });
            if (fresh.ok) {
              const recovered = (await fresh.json()) as Layer;
              syncAuthoritativeLayer(recovered, true);
              if (!opts.skipRefresh && changesRender) {
                await refreshLayer(layerId);
              }
              return recovered;
            }
          } catch {
            // Fall through to the unconfirmed surface below.
          }
          // Current truth could not be established: the write landed, but
          // what is on screen may predate it. Say so and resync rather
          // than reporting success over a stale snapshot.
          fail(
            lane,
            "The layer save could not be confirmed. The re-read after a concurrent reload failed.",
          );
          reload();
          return null;
        }
        syncAuthoritativeLayer(updated, true);
        // Anything that changes the effective query needs fresh render data —
        // except a settled timeline window, whose caller skips the refetch:
        // docked data does not depend on the window.
        if (!opts.skipRefresh && changesRender) {
          await refreshLayer(layerId);
        }
        return updated;
      });
      layerPatchQueueRef.current[layerId] = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [
      refreshLayer,
      syncAuthoritativeLayer,
      track,
      clearFailure,
      fail,
      reload,
      reloadEpochRef,
      rendersRef,
    ],
  );

  return {
    /** Standing failure banners by lane; the reader can dismiss any. */
    failures,
    fail,
    clearFailure,
    /** In-flight tracked writes — non-zero shows the Saving… whisper. */
    pendingSaves,
    track,
    applyMapResponse,
    patchMap,
    patchLayer,
  };
}
