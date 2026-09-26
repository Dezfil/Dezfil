"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { DataTable } from "./api";
import type { SkippedMember } from "./skipped-members";
import {
  createUploadQueue,
  type UploadQueueEngine,
  type UploadQueueOptions,
  type UploadQueueSnapshot,
  type UploadTransport,
} from "./upload-queue";

export type {
  AttributedSkip,
  MatchingGate,
  MatchingStep,
  SettleReport,
  UploadEntry,
  UploadEntryState,
  UploadQueueOptions,
} from "./upload-queue";

/** The real transport: XHR rather than fetch so byte progress is real —
 * multi-GB files deserve an honest progress bar. A network error is
 * reported as lost, never as a refusal: the answer, not the import, is
 * what provably went missing. */
const xhrTransport: UploadTransport = (file, handlers, context) => {
  const form = new FormData();
  form.append("file", file);
  const xhr = new XMLHttpRequest();
  // The batch-captured import context: the documented upload road's
  // project parameter files every created table.
  xhr.open(
    "POST",
    context.projectId === null
      ? "/api/tables"
      : `/api/tables?project=${encodeURIComponent(context.projectId)}`,
  );
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) handlers.progress(e.loaded / e.total);
  };
  xhr.onerror = () => handlers.lost();
  xhr.onload = () => {
    try {
      const body = JSON.parse(xhr.responseText);
      if (xhr.status >= 400) {
        handlers.refused(
          body.error?.message ?? `Upload failed (${xhr.status})`,
        );
      } else {
        // Container formats answer with every table they created; each
        // file's answer bubbles as it lands.
        const answer = body as DataTable & {
          tables?: DataTable[];
          skipped?: SkippedMember[];
        };
        handlers.imported(answer.tables ?? [answer], answer.skipped ?? []);
      }
    } catch {
      handlers.refused(`Upload failed (${xhr.status})`);
    }
  };
  xhr.send(form);
};

export interface UploadQueue extends UploadQueueSnapshot {
  add: (files: File[]) => void;
  dismiss: () => number;
  reset: () => void;
  /** The engine's LIVE snapshot — for async consumers (the builder's
   * settle awaits layer work) that must not act on a superseded batch
   * through a stale render mirror. */
  current: () => UploadQueueSnapshot;
  /** The Add data dialog's gate for the column-matching step (spec
   * registered while it is mounted; the release resolves a
   * pending step plain. */
  registerMatchingGate: UploadQueueEngine["registerMatchingGate"];
  /** The step's end, confirmed or closed. */
  resolveMatching: UploadQueueEngine["resolveMatching"];
}

/**
 * The React binding over the upload-queue engine. Owned by the HOST
 * screen, never by the upload zone — the zone unmounts with its dialog,
 * while the active request must keep running and report through state
 * that survives (the plan's dialog-lifetime risk). The options are read
 * through a ref, so the latest host callbacks are always the ones
 * called.
 */
export function useUploadQueue(options: UploadQueueOptions): UploadQueue {
  const [engine] = useState<UploadQueueEngine>(() =>
    createUploadQueue(xhrTransport),
  );
  useEffect(() => {
    // The freshest host closures win at event time; queue events are
    // asynchronous, so the effect always lands first.
    engine.setOptions(options);
  });

  const snapshot = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getSnapshot,
  );

  return {
    ...snapshot,
    add: engine.add,
    dismiss: engine.dismiss,
    reset: engine.reset,
    current: engine.getSnapshot,
    registerMatchingGate: engine.registerMatchingGate,
    resolveMatching: engine.resolveMatching,
  };
}
