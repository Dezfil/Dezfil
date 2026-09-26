"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { readApiFailure } from "../api";
import { useLayerDownloadPreparationTimeoutMs } from "./LayerDownloadControlProvider";
import { layerDataFormatLabel, type LayerDataFormat } from "./export/formats";
import {
  LayerDownloadStatusObservations,
  LAYER_DOWNLOAD_STATUS_OBSERVATION_TIMEOUT_MS,
  startLayerDownloadControlRequest,
  startLayerDownloadPreparation,
} from "./layer-download-control";

const POLL_MS = 250;
const NETWORK_MESSAGE = "Could not reach the server. Try the download again.";
const TRANSFER_MESSAGE =
  "The download could not be confirmed. Check your Downloads, then retry if needed.";

interface DownloadDescriptor {
  key: string;
  mapId: string;
  layerId: string;
  layerName: string;
  format: LayerDataFormat;
  formatLabel: string;
}

interface DownloadJob extends DownloadDescriptor {
  cancelPreparation: (() => void) | null;
  cancelStatusObservation: (() => void) | null;
  frame: HTMLIFrameElement | null;
  pollTimer: number | null;
  ticket: string | null;
  statusObservations: LayerDownloadStatusObservations;
}

interface DownloadFailure extends DownloadDescriptor {
  message: string;
}

export interface MapScopedDownloadRecords<Active, Failure> {
  mapId: string;
  active: Record<string, Active>;
  failures: Record<string, Failure>;
}

/** A map transition starts a fresh UI lifetime; old records never resurrect. */
export function scopeLayerDownloadRecords<Active, Failure>(
  state: MapScopedDownloadRecords<Active, Failure>,
  mapId: string,
): MapScopedDownloadRecords<Active, Failure> {
  return state.mapId === mapId ? state : { mapId, active: {}, failures: {} };
}

export interface LayerDataDownloadPort {
  start: (layerId: string, format: LayerDataFormat) => boolean;
  active: (layerId: string, format: LayerDataFormat) => boolean;
}

export interface LayerDataDownloadFailureView extends DownloadFailure {
  retry: () => void;
  dismiss: () => void;
}

function downloadKey(
  mapId: string,
  layerId: string,
  format: LayerDataFormat,
): string {
  return `${mapId}:${layerId}:${format}`;
}

function baseUrl(layerId: string, format: LayerDataFormat): string {
  return `/api/layers/${encodeURIComponent(layerId)}/export/${format}`;
}

export function layerDataDownloadUrls(
  layerId: string,
  format: LayerDataFormat,
  ticket?: string,
): {
  prepare: string;
  download?: string;
  status?: string;
  release?: string;
} {
  const base = baseUrl(layerId, format);
  if (!ticket) return { prepare: `${base}?__ui_prepare=1` };
  const encoded = encodeURIComponent(ticket);
  return {
    prepare: `${base}?__ui_prepare=1`,
    download: `${base}?__ui_download=${encoded}`,
    status: `${base}?__ui_status=${encoded}`,
    release: `${base}?__ui_status=${encoded}&__ui_release=1`,
  };
}

function isStatusBody(
  value: unknown,
): value is { status: "prepared" | "streaming" | "complete" | "failed" } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    (body.status === "prepared" ||
      body.status === "streaming" ||
      body.status === "complete" ||
      body.status === "failed")
  );
}

/**
 * One builder-lifetime coordinator for all layer-data doors. Only small JSON
 * control envelopes enter JavaScript; file bytes travel from the same-origin
 * redemption URL through the browser's native attachment road.
 */
export function useLayerDataDownloads(
  mapId: string,
  layers: readonly Pick<Layer, "id" | "name">[],
): {
  port: LayerDataDownloadPort;
  activeDownloads: DownloadDescriptor[];
  failures: LayerDataDownloadFailureView[];
} {
  const preparationTimeoutMs = useLayerDownloadPreparationTimeoutMs();
  const jobsRef = useRef(new Map<string, DownloadJob>());
  const layerNames = useMemo(
    () => new Map(layers.map((layer) => [layer.id, layer.name])),
    [layers],
  );
  const [uiState, setUiState] = useState<
    MapScopedDownloadRecords<DownloadDescriptor, DownloadFailure>
  >({ mapId, active: {}, failures: {} });
  const scopedUiState = scopeLayerDownloadRecords(uiState, mapId);
  if (scopedUiState !== uiState) setUiState(scopedUiState);
  const active = scopedUiState.active;
  const failureState = scopedUiState.failures;
  const pollRef = useRef<(job: DownloadJob) => void>(() => {});

  const releaseTicket = useCallback((job: DownloadJob, ticket = job.ticket) => {
    if (!ticket) return;
    const release = layerDataDownloadUrls(
      job.layerId,
      job.format,
      ticket,
    ).release!;
    void fetch(release, { cache: "no-store", keepalive: true }).catch(() => {});
  }, []);

  const detach = useCallback((job: DownloadJob) => {
    if (jobsRef.current.get(job.key) !== job) return;
    jobsRef.current.delete(job.key);
    job.cancelPreparation?.();
    job.cancelPreparation = null;
    job.cancelStatusObservation?.();
    job.cancelStatusObservation = null;
    if (job.pollTimer !== null) window.clearTimeout(job.pollTimer);
    job.frame?.remove();
    setUiState((current) => {
      if (current.mapId !== job.mapId) return current;
      const next = { ...current.active };
      delete next[job.key];
      return { ...current, active: next };
    });
  }, []);

  const failJob = useCallback(
    (job: DownloadJob, message: string) => {
      if (jobsRef.current.get(job.key) !== job) return;
      releaseTicket(job);
      detach(job);
      setUiState((current) => {
        if (current.mapId !== job.mapId) return current;
        return {
          ...current,
          failures: {
            ...current.failures,
            [job.key]: {
              key: job.key,
              mapId: job.mapId,
              layerId: job.layerId,
              layerName: job.layerName,
              format: job.format,
              formatLabel: job.formatLabel,
              message,
            },
          },
        };
      });
    },
    [detach, releaseTicket],
  );

  const pollJob = useCallback(
    async (job: DownloadJob) => {
      if (jobsRef.current.get(job.key) !== job || !job.ticket) return;
      job.pollTimer = null;
      const status = layerDataDownloadUrls(
        job.layerId,
        job.format,
        job.ticket,
      ).status!;
      const observeUnconfirmedStatus = () => {
        if (job.statusObservations.recordUnconfirmed()) {
          failJob(job, TRANSFER_MESSAGE);
          return;
        }
        job.pollTimer = window.setTimeout(() => pollRef.current(job), POLL_MS);
      };
      const request = startLayerDownloadControlRequest(
        async (signal) => {
          const response = await fetch(status, {
            cache: "no-store",
            signal,
          });
          if (!response.ok) return null;
          const body: unknown = await response.json().catch(() => null);
          return isStatusBody(body) ? body : null;
        },
        { timeoutMs: LAYER_DOWNLOAD_STATUS_OBSERVATION_TIMEOUT_MS },
      );
      job.cancelStatusObservation = request.cancel;
      const outcome = await request.outcome;
      if (job.cancelStatusObservation === request.cancel) {
        job.cancelStatusObservation = null;
      }
      if (jobsRef.current.get(job.key) !== job) return;
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "timed-out" || outcome.kind === "rejected") {
        observeUnconfirmedStatus();
        return;
      }
      const body = outcome.value;
      if (!body) {
        observeUnconfirmedStatus();
        return;
      }
      job.statusObservations.recordValid();
      if (body.status === "complete") {
        detach(job);
        return;
      }
      if (body.status === "failed") {
        failJob(job, TRANSFER_MESSAGE);
        return;
      }
      job.pollTimer = window.setTimeout(() => pollRef.current(job), POLL_MS);
    },
    [detach, failJob],
  );
  useEffect(() => {
    pollRef.current = (job) => void pollJob(job);
  }, [pollJob]);

  const start = useCallback(
    (layerId: string, format: LayerDataFormat): boolean => {
      const key = downloadKey(mapId, layerId, format);
      if (jobsRef.current.has(key)) return false;
      const descriptor: DownloadDescriptor = {
        key,
        mapId,
        layerId,
        layerName: layerNames.get(layerId) ?? layerId,
        format,
        formatLabel: layerDataFormatLabel(format),
      };
      const job: DownloadJob = {
        ...descriptor,
        cancelPreparation: null,
        cancelStatusObservation: null,
        frame: null,
        pollTimer: null,
        ticket: null,
        statusObservations: new LayerDownloadStatusObservations(),
      };
      jobsRef.current.set(key, job);
      setUiState((current) => {
        const scoped = scopeLayerDownloadRecords(current, mapId);
        const failures = { ...scoped.failures };
        delete failures[key];
        return {
          ...scoped,
          active: { ...scoped.active, [key]: descriptor },
          failures,
        };
      });

      const preparation = startLayerDownloadPreparation({
        url: layerDataDownloadUrls(layerId, format).prepare,
        timeoutMs: preparationTimeoutMs,
        fetchControl: fetch,
        readFailureMessage: async (response) => {
          const failure = await readApiFailure(response);
          return publishedMessage(failure.code);
        },
        networkMessage: NETWORK_MESSAGE,
        invalidMessage: publishedMessage("internal"),
        isCurrent: () => jobsRef.current.get(key) === job,
        onFailure: (message) => failJob(job, message),
        releaseTicket: (ticket) => releaseTicket(job, ticket),
        onTicket: (ticket) => {
          job.ticket = ticket;
          const urls = layerDataDownloadUrls(layerId, format, ticket);
          const frame = document.createElement("iframe");
          frame.hidden = true;
          frame.setAttribute("aria-hidden", "true");
          frame.dataset.layerDownloadFrame = key;
          frame.src = urls.download!;
          document.body.appendChild(frame);
          job.frame = frame;
          pollRef.current(job);
        },
      });
      job.cancelPreparation = preparation.depart;
      void preparation.outcome.finally(() => {
        if (job.cancelPreparation === preparation.depart) {
          job.cancelPreparation = null;
        }
      });
      return true;
    },
    [failJob, layerNames, mapId, preparationTimeoutMs, releaseTicket],
  );

  useEffect(() => {
    const jobs = jobsRef.current;
    return () => {
      for (const job of jobs.values()) {
        releaseTicket(job);
        job.cancelPreparation?.();
        job.cancelStatusObservation?.();
        if (job.pollTimer !== null) window.clearTimeout(job.pollTimer);
        job.frame?.remove();
      }
      jobs.clear();
    };
    // A route transition can reuse this client component. Treat a new map
    // exactly like unmount so prepared files and active streams are released.
  }, [mapId, releaseTicket]);

  const activeDownloads = useMemo(
    () =>
      Object.values(active)
        .filter((download) => download.mapId === mapId)
        .sort((a, b) => a.key.localeCompare(b.key)),
    [active, mapId],
  );
  const activeKeys = useMemo(
    () => new Set(activeDownloads.map((download) => download.key)),
    [activeDownloads],
  );
  const port = useMemo<LayerDataDownloadPort>(
    () => ({
      start,
      active: (layerId, format) =>
        activeKeys.has(downloadKey(mapId, layerId, format)),
    }),
    [activeKeys, mapId, start],
  );
  const dismiss = useCallback(
    (key: string) => {
      setUiState((current) => {
        if (current.mapId !== mapId) return current;
        const failures = { ...current.failures };
        delete failures[key];
        return { ...current, failures };
      });
    },
    [mapId],
  );

  return {
    port,
    activeDownloads,
    failures: Object.values(failureState)
      .filter((failure) => failure.mapId === mapId)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((failure) => ({
        ...failure,
        retry: () => void start(failure.layerId, failure.format),
        dismiss: () => dismiss(failure.key),
      })),
  };
}
