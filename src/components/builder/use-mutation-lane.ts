"use client";

import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";
import { acceptedDocumentFacts } from "../accepted-document-facts";
import { readApiError } from "../api";
import type { LayerRenderData } from "./render-data";
import { BuilderDrafts } from "./builder-drafts";
import { confirmsLayerPatch, confirmsMapPatch } from "./map-save-recovery";
import { DocumentSequence, patchIntent } from "../document-sequence";

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
  sequence,
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
  edited,
  clearLegendLive,
}: {
  mapId: string;
  sequence: DocumentSequence;
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
  /** Any successful edit enables undo and clears redo. */
  edited: () => void;
  /** Discards a layer's in-progress Legend-tab text — a recovered read
   * is authoritative for it too. */
  clearLegendLive: (layerId: string, accepted?: Layer) => void;
}) {
  const drafts = useMemo(() => new BuilderDrafts(), []);
  const stale = useSyncExternalStore(sequence.subscribe, sequence.snapshot, sequence.snapshot);
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
      sequence.accept(body);
      authoritativeLayersRef.current = Object.fromEntries(layers.map((layer) => [layer.id, layer]));
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
        return drafts.apply(next);
      });
      if (changed) edited();
    },
    [
      drafts,
      authoritativeLayersRef,
      sequence,
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
      const compose = typeof request === "function" ? request : patchIntent(map, request);
      const ticket = drafts.map(compose);
      setMap(current => current ? { ...current, ...compose(current) } : current);
      const result = sequence.enqueue(async () => {
        if (sequence.stale) return false;
        // A queued whole-object body (basemap group toggles) built at call
        // time would be stale by its turn — the earlier queued edit already
        // landed. A thunk builds the body from server truth as the turn
        // starts, so queued edits compose instead of reverting each other.
        const body = compose(serverMapRef.current);
        // Taken inside the lane, immediately before the request goes out:
        // any layer confirmed after this point outranks what comes back.
        const sentAt = truthSeqRef.current;
        const epoch = reloadEpochRef.current;
        const revision = sequence.revision;
        const before = serverMapRef.current;
        const rollback = () => {
          if (sequence.stale || reloadEpochRef.current !== epoch) return;
          // An outage is not a stale refusal. Retire only the failed gesture
          // and rebuild from confirmed state with the remaining intent. Do not
          // feed optimistic field tickets back through response application.
          drafts.discard(ticket);
          setMap(current => serverMapRef.current ? drafts.apply(serverMapRef.current) : current);
        };
        const unconfirmed = async (cause: unknown) => {
          fail(
            "map",
            `The map save could not be confirmed. ${
              cause instanceof Error ? cause.message : "Network failure."
            }`,
          );
          // Read once inside the ordered turn. Only a confirmed outcome
          // supplies the next basis; stale refusals never enter this path.
          if (!revision) return;
          try {
            const read = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
            if (!read.ok) { rollback(); return; }
            const current = await read.json() as MapWithLayers;
            if (sequence.stale || reloadEpochRef.current !== epoch) return;
            const currentRevision = acceptedDocumentFacts(current).editRevision;
            if (!currentRevision) return;
            if (confirmsMapPatch(before, body, current)) {
              drafts.accepted(ticket, before);
              applyMapResponse(current, true, sentAt);
            } else if (currentRevision === revision) {
              // The unchanged basis proves this request never landed.
              // Drop only its optimistic intent; later gestures remain.
              drafts.discard(ticket);
              applyMapResponse(current, false, sentAt);
            }
          } catch { rollback(); }
        };

        let response: Response;
        try {
          response = await track(
            sequence.writeFetch(`/api/maps/${mapId}`, {
              method: "PATCH",
              headers: sequence.headers({
                "content-type": "application/json",
                ...(opts.changeGroup
                  ? { "X-Change-Group": opts.changeGroup }
                  : null),
              }),
              body: JSON.stringify(body),
            }),
          );
        } catch (cause) {
          await unconfirmed(cause);
          return false;
        }
        if (!response.ok) {
          fail("map", await readApiError(response));
          return false;
        }
        let updated: MapWithLayers;
        try {
          updated = (await response.json()) as MapWithLayers;
        } catch (cause) {
          await unconfirmed(cause);
          return false;
        }
        // A clean save clears this lane's standing failure — and only
        // this lane's.
        clearFailure("map");
        if (reloadEpochRef.current !== epoch) {
          // A whole-map resync (assistant turn, applied history step)
          // landed while this request was in flight: the echo is older
          // than the resync's truth and would revert it. Re-read instead
          // of applying (two writers converge).
          return false;
        }
        drafts.accepted(ticket, serverMapRef.current);
        applyMapResponse(updated, true, sentAt);
        return true;
      });
      return result;
    },
    [
      drafts,
      setMap,
      mapId,
      map,
      sequence,
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
      sequence.accept(layer);
      authoritativeLayersRef.current[layer.id] = layer;
      // This layer's own lane just spoke: no map response sent before now
      // may regress it.
      truthSeqRef.current += 1;
      layerConfirmedAtRef.current[layer.id] = truthSeqRef.current;
      if (serverMapRef.current) {
        serverMapRef.current = {
          ...serverMapRef.current,
          ...acceptedDocumentFacts(layer),
          layers: serverMapRef.current.layers.map((candidate) =>
            candidate.id === layer.id ? layer : candidate,
          ),
        };
      }
      // A recovered read is authoritative too: discard any live text that was
      // waiting for the lost response rather than leaving it over stale state.
      clearLegendLive(layer.id, layer);
      setMap((current) =>
        current
          ? {
              ...current,
              ...acceptedDocumentFacts(layer),
              layers: drafts.apply({ ...(serverMapRef.current ?? current), layers: (serverMapRef.current ?? current).layers.map((candidate) =>
                candidate.id === layer.id ? layer : candidate,
              ) }).layers,
            }
          : current,
      );
      if (changed) edited();
    },
    [
      drafts,
      authoritativeLayersRef,
      clearLegendLive,
      sequence,
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
      request: Record<string, unknown> | ((current: Layer) => Record<string, unknown>),
      opts: { skipRefresh?: boolean; separateHistoryStep?: boolean; skipUnchanged?: boolean } = {},
    ): Promise<Layer | null> => {
      const shown = map?.layers.find((layer) => layer.id === layerId);
      const compose = typeof request === "function" ? request : patchIntent(shown, request);
      const ticket = drafts.layer(layerId, current => compose(current));
      setMap(current => current ? { ...current, layers: current.layers.map(layer => layer.id === layerId ? { ...layer, ...compose(layer) } : layer) } : current);
      const result = sequence.enqueue(async () => {
        if (sequence.stale) return null;
        const current = authoritativeLayersRef.current[layerId];
        if (!current) return null;
        const body = compose(current);
        const epoch = reloadEpochRef.current;
        const revision = sequence.revision;
        const before = serverMapRef.current;
        const sentAt = truthSeqRef.current;
        // Failures are owned per layer lane: a save that fails on one
        // layer must keep its banner through another layer's success.
        const lane = `layer:${layerId}` as const;
        // A gesture may reset an earlier queued change. Compare only once
        // that predecessor has settled and this gesture owns the turn.
        if (opts.skipUnchanged && Object.entries(body).every(([key, value]) => JSON.stringify(value) === JSON.stringify(current[key as keyof Layer]))) {
          drafts.accepted(ticket, serverMapRef.current);
          // Retire the gesture locally. A cached layer's document facts
          // cannot establish a revision or attribution without a response.
          setMap(shown => shown ? { ...shown, layers: drafts.apply(serverMapRef.current ?? shown).layers } : shown);
          clearFailure(lane);
          return current;
        }
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
        const recover = async (cause: unknown): Promise<null> => {
          const detail = cause instanceof Error ? cause.message : "Network failure.";
          fail(lane, `The layer save could not be confirmed. ${detail}`);
          if (!revision) return null;
          try {
            const read = await fetch(`/api/maps/${mapId}`, { cache: "no-store" });
            if (!read.ok) return null;
            const recovered = await read.json() as MapWithLayers;
            if (sequence.stale || reloadEpochRef.current !== epoch) return null;
            const currentRevision = acceptedDocumentFacts(recovered).editRevision;
            if (!currentRevision) return null;
            if (confirmsLayerPatch(before, layerId, body, recovered)) {
              drafts.accepted(ticket, before);
              applyMapResponse(recovered, true, sentAt);
              if (!opts.skipRefresh && changesRender) await refreshLayer(layerId);
            } else if (currentRevision === revision) {
              // Only this failed gesture is gone. Other layers and later
              // gestures still own their drafts and failure notices.
              drafts.discard(ticket);
              applyMapResponse(recovered, false, sentAt);
            }
          } catch { /* An unknown outcome keeps its draft and accepted basis. */ }
          return null;
        };

        let response: Response;
        try {
          response = await track(
            sequence.writeFetch(`/api/layers/${layerId}`, {
              method: "PATCH",
              headers: sequence.headers(headers),
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
          // A response from an older editor lifetime cannot establish a basis.
          return null;
        }
        drafts.accepted(ticket, serverMapRef.current);
        syncAuthoritativeLayer(updated, true);
        // Anything that changes the effective query needs fresh render data —
        // except a settled timeline window, whose caller skips the refetch:
        // docked data does not depend on the window.
        if (!opts.skipRefresh && changesRender) {
          await refreshLayer(layerId);
        }
        return updated;
      });
      return result;
    },
    [
      map,
      mapId,
      applyMapResponse,
      truthSeqRef,
      sequence,
      setMap,
      drafts,
      authoritativeLayersRef,
      refreshLayer,
      syncAuthoritativeLayer,
      serverMapRef,
      track,
      clearFailure,
      fail,
          reloadEpochRef,
      rendersRef,
    ],
  );

  return {
    stale, drafts,
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
