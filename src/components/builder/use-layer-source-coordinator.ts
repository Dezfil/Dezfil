"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { Bounds } from "@/lib/geo-bounds";
import type { DataTable } from "../api";
import { readApiError } from "../api";
import { useTransientNotice } from "../use-transient-notice";
import { withSkips, type SkippedMember } from "../skipped-members";
import {
  useUploadQueue,
  type SettleReport,
  type UploadQueue,
} from "../use-upload-queue";
import { fetchLayerRender, renderBounds } from "./render-data";

/** One notice for one import batch: spatial
 * creates named, non-spatial tables honestly kept without a layer
 * attempt, definite failures and unconfirmed creates each their own
 * clause. The single-table success keeps the exact copy the builder
 * has always shown. Pure, for the tests. */
export function importBatchNotice(parts: {
  created: string[];
  nonSpatial: string[];
  failed: string[];
  unconfirmed: string[];
}): string {
  const bits: string[] = [];
  if (parts.created.length === 1) {
    bits.push(`Added ${parts.created[0]} to this map`);
  } else if (parts.created.length > 1) {
    bits.push(
      `Added ${parts.created.length} layers to this map: ${parts.created.join(", ")}`,
    );
  }
  for (const name of parts.nonSpatial) {
    bits.push(`${name} kept as a table: no geometry for a layer`);
  }
  for (const name of parts.failed) {
    bits.push(`${name} landed in datasets: adding the layer failed`);
  }
  if (parts.unconfirmed.length > 0) {
    bits.push(
      `Adding ${parts.unconfirmed.join(", ")} could not be confirmed, reloading`,
    );
  }
  return bits.join(" · ");
}

/** One local file's layer-domain outcome in an upload batch:
 * how many layers were confirmed for it, and the soft outcomes its
 * tables collected. Pure data, for the settle decision and the notes. */
export interface UploadFileOutcome {
  filename: string;
  confirmed: number;
  outcomes: string[];
}

/** The files that hold the catalog open: successfully
 * imported, yet not one confirmed layer. A partial-success file (one
 * layer confirmed, another table soft) deliberately does NOT hold —
 * the gate-ratified narrowing. */
export function unlayeredFiles(
  files: readonly UploadFileOutcome[],
): UploadFileOutcome[] {
  return files.filter((f) => f.confirmed === 0);
}

/** The per-table clauses of one file's soft note — the
 * upload and layer domains stay distinct in the wording. */
export function fileSoftOutcomes(parts: {
  nonSpatial: string[];
  failed: string[];
  unconfirmed: string[];
}): string[] {
  return [
    ...parts.nonSpatial.map(
      (name) => `${name} imported as a table: no geometry for a layer`,
    ),
    ...parts.failed.map((name) => `${name}: adding the layer failed`),
    ...parts.unconfirmed.map(
      (name) =>
        `${name}: the layer could not be confirmed; the map reloaded, nothing was retried`,
    ),
  ];
}

/** A held-open note for the catalog's Files pane. */
export interface UploadSoftNote {
  filename: string;
  outcomes: string[];
}

/** Inline outcome of a catalog create (spec decisions 7/8). */
export type CreateLayerOutcome =
  | { kind: "created" }
  | { kind: "rejected"; message: string }
  | { kind: "unconfirmed"; message: string };

/** The awaitable result for PostGIS's one landed table. Unlike the burst
 * import road, this result returns to the still-mounted pane so it can say
 * exactly whether a map layer exists. */
export type PostgisLayerOutcome =
  | { kind: "created"; layer: Layer }
  | { kind: "attribute_only"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "unconfirmed"; message: string };

type LayerRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** One PostGIS table's layer-domain operation, kept pure enough to prove all
 * four outcomes without mounting the builder. */
export async function createPostgisLayerFromTable(
  mapId: string,
  table: DataTable,
  request: LayerRequest = fetch,
): Promise<PostgisLayerOutcome> {
  if (table.geometryColumn === null) {
    return {
      kind: "attribute_only",
      message: `${table.name} was imported as a table. It has no geometry for a layer.`,
    };
  }
  try {
    const response = await request(`/api/maps/${mapId}/layers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The imported table is the importer's own: named as their console
      // names it and carried into the map's home by the server.
      body: JSON.stringify({
        name: table.name,
        sql: `SELECT * FROM ${table.name}`,
        writtenIn: { kind: "console" },
      }),
    });
    if (!response.ok) {
      return { kind: "rejected", message: await readApiError(response) };
    }
    try {
      return { kind: "created", layer: (await response.json()) as Layer };
    } catch {
      return {
        kind: "unconfirmed",
        message:
          "The layer create could not be confirmed. The layer may exist. Reloading the map's state; nothing was retried.",
      };
    }
  } catch {
    return {
      kind: "unconfirmed",
      message:
        "The layer create could not be confirmed. The layer may exist. Reloading the map's state; nothing was retried.",
    };
  }
}

/** If the pane was dismissed while its submitted operation continued, the
 * builder's durable notice channel keeps the outcome from disappearing. */
export function dismissedPostgisNotice(
  table: DataTable,
  outcome: PostgisLayerOutcome,
): string {
  if (outcome.kind === "created") return `Added ${outcome.layer.name} to this map`;
  if (outcome.kind === "attribute_only") {
    return `${table.name} kept as a table: no geometry for a layer`;
  }
  if (outcome.kind === "rejected") {
    return `${table.name} landed in datasets: adding the layer failed`;
  }
  return `Adding ${table.name} could not be confirmed, reloading`;
}

/** What the catalog was opened for: creating a layer, or editing one
 * layer's source — scoped by immutable id, captured at open. */
export type CatalogRequest =
  | { kind: "add" }
  | { kind: "edit"; layerId: string; layerName: string; sql: string };

interface Deps {
  request?: typeof fetch;
  mapId: string;
  reload: () => void;
  edited: () => void;
  setSelectedId: (id: string | null) => void;
  setFitBounds: (bounds: Bounds) => void;
  /** The lane's reconciling layer save — the edit path rides it. */
  patchLayer: (
    layerId: string,
    body: Record<string, unknown>,
  ) => Promise<Layer | null>;
  /** The map's project — the upload batch's import
   * context, captured when a batch is admitted. */
  projectId: string | null;
}

/**
 * The builder's layer-source coordination: everything that turns a
 * table or a SQL query into a layer on this map — the catalog's open
 * state and outcomes, the inline create path with its unconfirmed
 * handling, the batch-settled import completion with its focus-window
 * framing and notices, and the scoped source-edit path over the
 * reconciling save lane.
 */
export function useLayerSourceCoordinator({
  request = fetch,
  mapId,
  reload,
  edited,
  setSelectedId,
  setFitBounds,
  patchLayer,
  projectId,
}: Deps) {
  /** The import focus window: while active, reloads keep
   * their hands off the camera and imports frame their own layers. */
  const importFocusRef = useRef<{
    active: boolean;
    bounds: Bounds | null;
    timer: number | null;
  }>({ active: false, bounds: null, timer: null });
  useEffect(
    () => () => {
      if (importFocusRef.current.timer) {
        window.clearTimeout(importFocusRef.current.timer);
      }
    },
    [],
  );

  // One transient notice channel for import and source-edit outcomes.
  const { notice: importNotice, show: showImportNotice } =
    useTransientNotice();
  // Skipped container members — composed via withSkips.
  const pendingSkipsRef = useRef<SkippedMember[] | null>(null);
  const setPendingSkips = useCallback((skipped: SkippedMember[]) => {
    pendingSkipsRef.current = skipped;
  }, []);

  const onLayerAdded = useCallback(
    (layer: Layer) => {
      setSelectedId(layer.id);
      reload(); // reload reframes to include the new layer
      edited();
    },
    [reload, edited, setSelectedId],
  );

  // The catalog's create path: same endpoint, inline outcomes — a
  // definite rejection stays beside the draft; an unconfirmed create
  // surfaces the uncertainty while authoritative state reloads, without
  // automatic retry (spec decision 8). Durable work lives here, in the
  // builder's lifetime, so closing the catalog never orphans it.
  const createLayerInline = useCallback(
    async (name: string, sql: string, writtenIn?: { kind: "console" }): Promise<CreateLayerOutcome> => {
      try {
        const trimmed = name.trim();
        const response = await request(`/api/maps/${mapId}/layers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(trimmed !== "" ? { name: trimmed } : {}),
            sql,
            ...(writtenIn ? { writtenIn } : {}),
          }),
        });
        if (!response.ok) {
          return { kind: "rejected", message: await readApiError(response) };
        }
        const layer = (await response.json()) as Layer;
        onLayerAdded(layer);
        return { kind: "created" };
      } catch {
        reload();
        return {
          kind: "unconfirmed",
          message:
            "The create could not be confirmed. The layer may exist. Reloading the map's state; nothing was retried.",
        };
      }
    },
    [mapId, onLayerAdded, reload, request],
  );

  // The catalog's import completion: per-table
  // callbacks from a container import arrive in one synchronous burst —
  // collected here, then settled as ONE batch: spatial tables become
  // layers (each create its own history entry), non-spatial tables are
  // kept and reported without a layer attempt, the newest layer is
  // selected, one reload, one union framing, one notice.
  const pendingBatchRef = useRef<DataTable[] | null>(null);
  // The table→layer create loop, shared by the synchronous-burst path
  // and the upload batch: upload success and layer-creation success are
  // distinct domains, and this loop only ever speaks the second.
  const createLayersFromTables = useCallback(
    async (batch: DataTable[]) => {
      const created: Layer[] = [];
      const failed: string[] = [];
      const unconfirmed: string[] = [];
      for (const table of batch) {
        if (table.geometryColumn === null) continue; // no attempt — reported later
        try {
          const response = await request(`/api/maps/${mapId}/layers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: table.name,
              sql: `SELECT * FROM ${table.name}`,
              writtenIn: { kind: "console" },
            }),
          });
          if (!response.ok) {
            failed.push(table.name);
            continue;
          }
          try {
            created.push((await response.json()) as Layer);
          } catch {
            unconfirmed.push(table.name);
          }
        } catch {
          unconfirmed.push(table.name);
        }
      }
      return { created, failed, unconfirmed };
    },
    [mapId, request],
  );
  const processBatch = useCallback(
    async (batch: DataTable[]) => {
      if (batch.length === 0) return;
      const skips = pendingSkipsRef.current;
      pendingSkipsRef.current = null; // consumed — never re-reported
      const { created, failed, unconfirmed } =
        await createLayersFromTables(batch);
      if (created.length > 0) {
        setSelectedId(created[created.length - 1].id);
        edited();
      }
      // One authoritative reload for the batch (also the unconfirmed
      // recovery, — never an automatic retry).
      if (created.length > 0 || unconfirmed.length > 0) reload();
      if (created.length > 0) {
        // The focus window: frame the union of what landed.
        const focus = importFocusRef.current;
        focus.active = true;
        if (focus.timer) window.clearTimeout(focus.timer);
        focus.timer = window.setTimeout(() => {
          focus.active = false;
          focus.bounds = null;
        }, 6000);
        const layerRenders = await Promise.all(
          created.map((l) => fetchLayerRender(l.id)),
        );
        const b = renderBounds(layerRenders);
        if (b && focus.active) {
          focus.bounds = b;
          setFitBounds([...b] as Bounds);
        }
      }
      showImportNotice(
        withSkips(
          importBatchNotice({
            created: created.map((l) => l.name),
            nonSpatial: batch
              .filter((t) => t.geometryColumn === null)
              .map((t) => t.name),
            failed,
            unconfirmed,
          }),
          skips,
        ),
      );
    },
    [
      createLayersFromTables,
      edited,
      reload,
      setFitBounds,
      setSelectedId,
      showImportNotice,
    ],
  );
  const onCatalogTableImported = useCallback(
    (table: DataTable) => {
      if (pendingBatchRef.current === null) {
        pendingBatchRef.current = [table];
        window.setTimeout(() => {
          const batch = pendingBatchRef.current;
          pendingBatchRef.current = null;
          if (batch) void processBatch(batch);
        }, 0);
      } else {
        pendingBatchRef.current.push(table);
      }
    },
    [processBatch],
  );

  // The catalog's open state: a create request, or one layer's source
  // scoped by the request captured at open — never following the
  // inspector selection afterwards.
  const [catalogRequest, setCatalogRequest] = useState<CatalogRequest | null>(
    null,
  );
  const catalogOpenRef = useRef(false);
  const uploadQueueRef = useRef<UploadQueue | null>(null);
  // The held-open notes, stamped with their batch: a newer batch's
  // snapshot hides them without an event, and closing the catalog drops
  // them (notes persist until a new batch or host close).
  const [uploadNotesState, setUploadNotesState] = useState<{
    batch: number;
    files: UploadSoftNote[];
  } | null>(null);
  useEffect(() => {
    // Queue events are asynchronous; the mirror is always fresh by the
    // time a settle reads it.
    catalogOpenRef.current = catalogRequest !== null;
  }, [catalogRequest]);
  const openCatalogAdd = useCallback(() => {
    // A fresh session owns no earlier import's skips: Overture, OSM and
    // PostGIS never report skips, so a stale set would ride into their
    // next batch's notice.
    pendingSkipsRef.current = null;
    // A settled batch's display is stale history by now; a batch still
    // running keeps showing — reset() refuses to drop a live record.
    uploadQueueRef.current?.reset();
    setUploadNotesState(null);
    catalogOpenRef.current = true;
    setCatalogRequest({ kind: "add" });
  }, []);
  const openCatalogEdit = useCallback((layer: Layer) => {
    pendingSkipsRef.current = null;
    catalogOpenRef.current = true;
    setCatalogRequest({
      kind: "edit",
      layerId: layer.id,
      layerName: layer.name,
      sql: layer.sql,
    });
  }, []);
  const closeCatalog = useCallback(() => {
    // Closing by hand mid-batch stops what has not started; the request
    // in flight keeps running here, in the builder's lifetime, and its
    // outcome lands through the notice channel.
    const queue = uploadQueueRef.current;
    if (queue) {
      const stopped = queue.dismiss();
      if (stopped > 0) {
        showImportNotice(
          stopped === 1
            ? "Stopped. 1 queued file was not started."
            : `Stopped. ${stopped} queued files were not started.`,
        );
      }
      if (queue.settled) queue.reset();
    }
    // Held-open notes die with the host.
    catalogOpenRef.current = false;
    setUploadNotesState(null);
    setCatalogRequest(null);
  }, [showImportNotice]);
  // The upload batch ——— Files upload through the host-owned queue;
  // each file's tables enter the layer flow as they land, while
  // selection, framing and the one notice wait for the whole batch.
  // Upload success and layer-creation success stay distinct domains
  // throughout.
  const uploadAccRef = useRef<{
    /** The batch these outcomes belong to — a later batch never reads
     * or feeds an earlier batch's accumulator. */
    batch: number;
    created: Layer[];
    nonSpatial: string[];
    layerFailed: string[];
    layerUnconfirmed: string[];
    /** Per-file attribution: the settle decides closure
     * per file, and the held-open notes name files. */
    files: UploadFileOutcome[];
  } | null>(null);
  // Layer creation is async while the queue's callbacks are not: the
  // work chains here, in file order, and settlement awaits the chain.
  const uploadWorkRef = useRef<Promise<void>>(Promise.resolve());
  // Bumped whenever the authoritative table set may have changed, so
  // the open catalog re-reads its dataset listing (the rule's refresh).
  const [catalogListingStamp, setCatalogListingStamp] = useState(0);

  const onPostgisTableImported = useCallback(
    async (table: DataTable): Promise<PostgisLayerOutcome> => {
      // The snapshot is already durable. Refresh the catalog's table truth
      // independently of whether its layer succeeds.
      setCatalogListingStamp((n) => n + 1);
      const outcome = await createPostgisLayerFromTable(mapId, table, request);
      if (outcome.kind === "created") {
        setSelectedId(outcome.layer.id);
        edited();
        reload();

        const focus = importFocusRef.current;
        focus.active = true;
        if (focus.timer) window.clearTimeout(focus.timer);
        focus.timer = window.setTimeout(() => {
          focus.active = false;
          focus.bounds = null;
        }, 6000);
        const bounds = renderBounds([await fetchLayerRender(outcome.layer.id)]);
        if (bounds && focus.active) {
          focus.bounds = bounds;
          setFitBounds([...bounds] as Bounds);
        }
      } else if (outcome.kind === "unconfirmed") {
        // Authoritative recovery, never an automatic retry.
        reload();
      }
      if (!catalogOpenRef.current) {
        showImportNotice(dismissedPostgisNotice(table, outcome));
      }
      return outcome;
    },
    [request, edited, mapId, reload, setFitBounds, setSelectedId, showImportNotice],
  );

  const settleUploadBatch = useCallback(
    async (report: SettleReport) => {
      await uploadWorkRef.current; // every file's layer work has landed
      // A newer batch may have started while this settle awaited (the
      // PR round's race): its work must not be consumed here, and this
      // settle must not move the camera, selection, or host under it.
      const superseded = () => {
        const live = uploadQueueRef.current?.current();
        return live?.settled !== true || live.batch !== report.batch;
      };
      const acc =
        uploadAccRef.current?.batch === report.batch
          ? uploadAccRef.current
          : {
              batch: report.batch,
              created: [],
              nonSpatial: [],
              layerFailed: [],
              layerUnconfirmed: [],
              files: [] as UploadFileOutcome[],
            };
      if (uploadAccRef.current?.batch === report.batch) {
        uploadAccRef.current = null;
      }
      const focus = importFocusRef.current;
      if (acc.created.length > 0 && !superseded()) {
        // Selection and framing span the WHOLE batch:
        // the newest layer selected, the union of everything framed.
        setSelectedId(acc.created[acc.created.length - 1].id);
        edited();
        focus.active = true;
        if (focus.timer) window.clearTimeout(focus.timer);
        focus.timer = window.setTimeout(() => {
          focus.active = false;
          focus.bounds = null;
        }, 6000);
        const renders = await Promise.all(
          acc.created.map((l) => fetchLayerRender(l.id)),
        );
        const b = renderBounds(renders);
        if (b && focus.active && !superseded()) {
          focus.bounds = b;
          setFitBounds([...b] as Bounds);
        }
      } else if (!superseded()) {
        focus.active = false;
        focus.bounds = null;
        if (focus.timer) window.clearTimeout(focus.timer);
      }
      const bits = [
        importBatchNotice({
          created: acc.created.map((l) => l.name),
          nonSpatial: acc.nonSpatial,
          failed: acc.layerFailed,
          unconfirmed: acc.layerUnconfirmed,
        }),
      ].filter((t) => t !== "");
      // Outcomes named by file: the catalog may already
      // be closed, and this notice is then the only account.
      const named = (state: string) =>
        report.entries
          .filter((e) => e.state === state)
          .map((e) => e.name)
          .join(", ");
      if (report.failed > 0) {
        bits.push(
          report.failed === 1
            ? `${named("failed")} failed`
            : `${report.failed} files failed (${named("failed")})`,
        );
      }
      if (report.unconfirmed > 0) {
        bits.push(`${named("unconfirmed")} unconfirmed, datasets re-read`);
      }
      if (report.notStarted > 0) {
        bits.push(`${report.notStarted} not started`);
      }
      const text = withSkips(
        bits.join(" · "),
        report.skips.length
          ? report.skips.map(({ source, layer, reason }) => ({
              layer: `${source}: ${layer}`,
              reason,
            }))
          : null,
      );
      if (text !== "") showImportNotice(text);
      const clean =
        report.failed === 0 &&
        report.unconfirmed === 0 &&
        report.notStarted === 0;
      // The host moves only for the batch the engine still shows.
      if (superseded()) return;
      // The catalog closes only when every successfully imported file
      // produced at least one confirmed layer. A file that did not
      // holds it open with a named note; the user leaves by choice,
      // knowing.
      const soft = unlayeredFiles(acc.files);
      if (clean && soft.length === 0 && catalogOpenRef.current) {
        // The host closes at settlement, not at first table.
        setCatalogRequest(null);
      } else if (!catalogOpenRef.current) {
        // Dismissed mid-batch: the outcome just landed through the
        // notice; the settled batch drops so the next open is fresh.
        uploadQueueRef.current?.reset();
      } else if (soft.length > 0) {
        setUploadNotesState({
          batch: report.batch,
          files: soft.map(({ filename, outcomes }) => ({
            filename,
            outcomes,
          })),
        });
      }
    },
    [edited, setFitBounds, setSelectedId, showImportNotice],
  );

  const uploadQueue = useUploadQueue({
    // The batch-captured import context: a filed map's uploads join its
    // project; the engine captures at admission.
    projectId,
    onFileImported: (tables, _skipped, filename) => {
      // Arm the focus window for the batch's duration: the per-file
      // reloads that make layers appear keep their hands off the
      // camera; settlement frames the union.
      const focus = importFocusRef.current;
      focus.active = true;
      if (focus.timer) window.clearTimeout(focus.timer);
      // The file's batch, captured synchronously — the chained work
      // below runs later and must never feed another batch's
      // accumulator.
      const batch = uploadQueueRef.current?.current().batch ?? 0;
      uploadWorkRef.current = uploadWorkRef.current.then(async () => {
        if (uploadAccRef.current && uploadAccRef.current.batch !== batch) {
          uploadAccRef.current = null;
        }
        const acc = (uploadAccRef.current ??= {
          batch,
          created: [],
          nonSpatial: [],
          layerFailed: [],
          layerUnconfirmed: [],
          files: [],
        });
        const nonSpatial = tables
          .filter((t) => t.geometryColumn === null)
          .map((t) => t.name);
        acc.nonSpatial.push(...nonSpatial);
        const out = await createLayersFromTables(tables);
        acc.created.push(...out.created);
        acc.layerFailed.push(...out.failed);
        acc.layerUnconfirmed.push(...out.unconfirmed);
        // Per-file attribution: settlement closes only when every file
        // confirmed a layer, and holds by naming files.
        acc.files.push({
          filename,
          confirmed: out.created.length,
          outcomes: fileSoftOutcomes({
            nonSpatial,
            failed: out.failed,
            unconfirmed: out.unconfirmed,
          }),
        });
        if (out.created.length > 0 || out.unconfirmed.length > 0) reload();
        setCatalogListingStamp((n) => n + 1);
      });
    },
    onListingStale: () => {
      // An unconfirmed upload re-reads authoritative state — the map
      // and the catalog's dataset listing — and retries nothing.
      reload();
      setCatalogListingStamp((n) => n + 1);
    },
    onSettled: (report) => void settleUploadBatch(report),
  });
  useEffect(() => {
    uploadQueueRef.current = uploadQueue;
  }, [uploadQueue]);

  const updateCatalogLayerSql = useCallback(
    async (sql: string): Promise<boolean> => {
      const request = catalogRequest;
      if (request?.kind !== "edit") return false;
      const t0 = performance.now();
      const updated = await patchLayer(request.layerId, { sql });
      if (updated === null) return false;
      // The update confirmation through the one transient notice channel
      // — visible once the dialog closes over the re-render.
      showImportNotice(
        `Updated ${updated.name} · ${Math.round(performance.now() - t0)} ms`,
      );
      return true;
    },
    [catalogRequest, patchLayer, showImportNotice],
  );

  return {
    importFocusRef,
    importNotice,
    /** The same transient channel, for source-edit confirmations:
     * one notice surface in the header chrome, whatever fed it. */
    showNotice: showImportNotice,
    catalogRequest,
    openCatalogAdd,
    openCatalogEdit,
    closeCatalog,
    updateCatalogLayerSql,
    onCatalogTableImported,
    onPostgisTableImported,
    setPendingSkips,
    onLayerAdded,
    createLayerInline,
    /** The map the catalog adds to: its SQL previews run in its home. */
    mapId,
    // The held-open notes ride the queue object the catalog already
    // receives (plan: the existing model, the builder shell untouched).
    // A newer batch's stamp hides stale notes.
    uploadQueue: {
      ...uploadQueue,
      softNotes:
        uploadNotesState && uploadNotesState.batch === uploadQueue.batch
          ? uploadNotesState.files
          : null,
    },
    catalogListingStamp,
  };
}
