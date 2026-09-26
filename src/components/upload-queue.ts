import type { DataTable } from "./api";
import type { AttributedSkip, SkippedMember } from "./skipped-members";

/**
 * The upload batch queue's engine: an ordered, sequential batch of local
 * files, one request in flight at a time, each file attempted exactly
 * once. Framework-free with an injected transport, so the sequencing,
 * settlement and dismissal semantics are provable without a browser; the
 * React binding lives in use-upload-queue.
 *
 * Outcomes per file: imported, failed (the file's own error, batch
 * continues), unconfirmed (the answer was lost — the server may have
 * committed; never retried, the host refreshes its listing), and
 * not-started (dismissal snapshot). Files added while the batch runs
 * append; files added after settlement begin a fresh batch and clear
 * the old display.
 *
 * The column-matching step lives here too: a landed file the mounted
 * dialog's gate holds enters a non-terminal "matching" state, the next
 * request waits behind it and settlement waits for it, until the step
 * resolves as confirmed or closed. Without a gate a landing is never
 * held, so the builder's catalog and a closed dialog land as today.
 */

export type UploadEntryState =
  | "queued"
  | "uploading"
  | "converting"
  /** Landed, and held by the dialog's step until it is answered or
   * closed: not terminal, so the batch waits behind it. */
  | "matching"
  | "imported"
  | "failed"
  | "unconfirmed"
  | "not-started";

/** The step the dialog shows for a held file. */
export interface MatchingStep {
  /** The held entry's id. */
  id: number;
  /** The file's name, for the header. */
  name: string;
  /** The landed table the step corrects API. */
  table: DataTable;
  /** The batch's files not yet started, in order: the note under the
   * controls names them, and it follows every snapshot. */
  waiting: string[];
}

/** What the mounted dialog registers: which of a file's
 * landed tables needs the step, or none. Only one gate at a time; a
 * landing with no gate is never held. */
export type MatchingGate = (tables: DataTable[]) => DataTable | null;

export interface UploadEntry {
  id: number;
  name: string;
  state: UploadEntryState;
  /** 0..1 while uploading. */
  progress: number;
  /** The file's own refusal, when failed; the uncertainty note when
   * unconfirmed. */
  error: string | null;
}

export type { AttributedSkip };

export interface SettleReport {
  files: number;
  imported: number;
  failed: number;
  unconfirmed: number;
  notStarted: number;
  /** Every entry with its terminal state — hosts reporting outside a
   * closed dialog name outcomes by file, never as bare counts (the PR
   * round: an aggregate "1 file failed" is not a named outcome). */
  entries: UploadEntry[];
  /** Every table the batch created, in landing order. */
  tables: DataTable[];
  skips: AttributedSkip[];
  /** True when the settle followed a manual dismissal. */
  dismissed: boolean;
  /** The batch this report settles — an async consumer compares it to
   * the live snapshot before acting on a possibly superseded batch. */
  batch: number;
}

export interface UploadQueueOptions {
  /** One file's successful answer, as it lands. */
  onFileImported?: (
    tables: DataTable[],
    skipped: SkippedMember[],
    filename: string,
  ) => void;
  /** The listing no longer describes a file's table — refresh the
   * authoritative listing: an unconfirmed outcome, and a matching step
   * confirmed, whose table gained geometry after it landed. Never a
   * second landing notice. */
  onListingStale?: () => void;
  /** The batch settled: every file reached a terminal state. */
  onSettled?: (report: SettleReport) => void;
  /** The import context the NEXT admitted batch captures;
   * an already-admitted batch keeps the value it captured. */
  projectId?: string | null;
}

/** What a transport reports back for one file's request. Exactly one
 * terminal call (imported / refused / lost) per file. */
export interface UploadTransportHandlers {
  progress: (fraction: number) => void;
  imported: (tables: DataTable[], skipped: SkippedMember[]) => void;
  refused: (message: string) => void;
  /** The answer was lost in transit — not a verdict. */
  lost: () => void;
}

/** Request context captured when a batch is admitted: one
 * user admission files as one act, so a mid-batch host change never
 * splits an admitted batch across destinations. */
export interface UploadRequestContext {
  /** The project every table of this batch files into; null = unfiled. */
  projectId: string | null;
}

export type UploadTransport = (
  file: File,
  handlers: UploadTransportHandlers,
  context: UploadRequestContext,
) => void;

export interface UploadQueueSnapshot {
  entries: UploadEntry[];
  /** The project the RUNNING batch captured at admission: a host whose
   * scope changed since must say this, not
   * its current scope, since appended files join this batch. Null when
   * the batch is unfiled or no batch runs. */
  projectId: string | null;
  /** Index of the in-flight entry, or null. */
  active: number | null;
  settled: boolean;
  /** Batch position, 1-based: the active file's number. */
  position: number;
  /** Skips accumulated so far, attributed to their source files — the
   * zone shows them while a mixed batch keeps the host open (the PR
   * round: they must not exist only in a close-time notice). */
  skips: AttributedSkip[];
  /** Monotonic batch number; a fresh batch increments it. */
  batch: number;
  /** The held file's step, while one is pending; at most one
   * at a time, by construction. */
  matching: MatchingStep | null;
}

export interface UploadQueueEngine {
  getSnapshot: () => UploadQueueSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Replace the host callbacks — the React binding refreshes them per
   * render so the latest closures always take the events. */
  setOptions: (options: UploadQueueOptions) => void;
  add: (files: File[]) => void;
  /** Snapshot queued files as not-started; the active request keeps
   * running; a pending step resolves plain, since the host is closing.
   * Returns how many were stopped. */
  dismiss: () => number;
  /** Drop a settled batch entirely (host closed after settlement). */
  reset: () => void;
  /** The mounted dialog's gate: consulted at every landing
   * while registered. Returns the release; releasing resolves a pending
   * step plain, so nothing waits behind a dialog that is gone. */
  registerMatchingGate: (gate: MatchingGate) => () => void;
  /** The step's end: confirmed (the table gained geometry, the listing
   * refresh fires) or closed (a plain table). The entry becomes
   * imported and the batch goes on. A step no longer pending changes
   * nothing in the batch; a confirmed outcome still refreshes. */
  resolveMatching: (id: number, outcome: "confirmed" | "closed") => void;
}

interface EngineEntry extends UploadEntry {
  file: File | null;
  /** The landed table a pending step corrects. */
  held: DataTable | null;
}

const UNCONFIRMED_NOTE =
  "The connection dropped. The file may still have imported.";

export function createUploadQueue(
  transport: UploadTransport,
  initialOptions: UploadQueueOptions = {},
): UploadQueueEngine {
  let options = initialOptions;
  let entries: EngineEntry[] = [];
  /** Captured at batch admission — see UploadRequestContext. */
  let batchProjectId: string | null = null;
  let active: number | null = null;
  let settled = false;
  let dismissed = false;
  let nextId = 1;
  let batchSeq = 0;
  let tables: DataTable[] = [];
  let skips: AttributedSkip[] = [];
  let gate: MatchingGate | null = null;

  const listeners = new Set<() => void>();
  let snapshot: UploadQueueSnapshot = {
    entries: [],
    projectId: null,
    active: null,
    settled: false,
    position: 1,
    skips: [],
    batch: 0,
    matching: null,
  };

  const pendingStep = () => entries.find((e) => e.state === "matching") ?? null;

  const publish = () => {
    const terminal = entries.filter(
      (e) =>
        e.state !== "queued" &&
        e.state !== "uploading" &&
        e.state !== "converting" &&
        e.state !== "matching",
    ).length;
    const held = pendingStep();
    snapshot = {
      entries: entries.map((e) => ({
        id: e.id,
        name: e.name,
        state: e.state,
        progress: e.progress,
        error: e.error,
      })),
      projectId: settled || entries.length === 0 ? null : batchProjectId,
      active,
      settled,
      // A held file is the batch's current one, as an active one is.
      position: Math.min(
        Math.max(terminal + (active !== null || held ? 1 : 0), 1),
        Math.max(entries.length, 1),
      ),
      skips: [...skips],
      batch: batchSeq,
      matching:
        held && held.held
          ? {
              id: held.id,
              name: held.name,
              table: held.held,
              waiting: entries.filter((e) => e.state === "queued").map((e) => e.name),
            }
          : null,
    };
    for (const listener of listeners) listener();
  };

  const settleIfDone = () => {
    if (entries.length === 0 || settled) return;
    settled = true;
    publish();
    options.onSettled?.({
      files: entries.length,
      imported: entries.filter((e) => e.state === "imported").length,
      failed: entries.filter((e) => e.state === "failed").length,
      unconfirmed: entries.filter((e) => e.state === "unconfirmed").length,
      notStarted: entries.filter((e) => e.state === "not-started").length,
      entries: snapshot.entries,
      tables: [...tables],
      skips: [...skips],
      dismissed,
      batch: batchSeq,
    });
  };

  const startNext = () => {
    // The batch waits file by file behind a pending step: no
    // next request while one is open, appended files included, and no
    // settlement either, since settlement is reached only through here
    // or through a dismissal, which resolves the step first (plan risk
    // 1). A pending step is not a terminal state.
    if (pendingStep()) {
      active = null;
      publish();
      return;
    }
    const index = entries.findIndex((e) => e.state === "queued");
    if (index === -1) {
      active = null;
      settleIfDone();
      publish();
      return;
    }

    active = index;
    const entry = entries[index];
    const file = entry.file;
    entry.file = null; // one attempt, ever — the bytes are handed off
    entry.state = "uploading";
    entry.progress = 0;
    publish();

    let done = false;
    const finish = (
      state: "imported" | "failed" | "unconfirmed",
      error: string | null,
    ) => {
      if (done) return; // a transport reports one terminal, once
      done = true;
      entry.state = state;
      entry.error = error;
      if (state === "unconfirmed") options.onListingStale?.();
      startNext();
    };

    transport(
      file as File,
      {
        progress: (fraction) => {
          if (done) return;
          entry.progress = fraction;
          entry.state = fraction >= 1 ? "converting" : "uploading";
          publish();
        },
        imported: (answerTables, answerSkipped) => {
          if (done) return;
          tables.push(...answerTables);
          skips.push(
            ...answerSkipped.map((s) => ({ ...s, source: entry.name })),
          );
          // The table landed: the host learns of it here, once, whether
          // or not a step follows.
          options.onFileImported?.(answerTables, answerSkipped, entry.name);
          const held = gate ? gate(answerTables) : null;
          if (held === null) {
            finish("imported", null);
            return;
          }
          // Held for the step: the request is over, the file is not
          // terminal, and the batch waits.
          done = true;
          entry.state = "matching";
          entry.error = null;
          entry.held = held;
          active = null;
          publish();
        },
        refused: (message) => finish("failed", message),
        // A lost answer is not a verdict: the server may have committed
        // before the connection dropped — unconfirmed, never failed,
        // never retried; the host refreshes its listing.
        lost: () => finish("unconfirmed", UNCONFIRMED_NOTE),
      },
      { projectId: batchProjectId },
    );
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOptions: (next) => {
      options = next;
    },
    add: (files) => {
      if (files.length === 0) return;
      if (settled || entries.length === 0) {
        // A fresh batch: the previous display clears,
        // and the import context is captured here — a mid-batch append
        // or option change never redirects the tail.
        entries = [];
        settled = false;
        dismissed = false;
        tables = [];
        skips = [];
        batchSeq += 1;
        batchProjectId = options.projectId ?? null;
      }
      for (const file of files) {
        entries.push({
          id: nextId++,
          name: file.name,
          state: "queued",
          progress: 0,
          error: null,
          file,
          held: null,
        });
      }
      if (active === null) startNext();
      else publish();
    },
    dismiss: () => {
      if (settled) return 0;
      let stopped = 0;
      for (const entry of entries) {
        if (entry.state === "queued") {
          entry.state = "not-started";
          entry.file = null;
          stopped += 1;
        }
      }
      if (stopped > 0) dismissed = true;
      // The host is closing: a pending step closes plain with it, its
      // file a plain table that counts as imported. Resolved here,
      // inside the dismissal, so the batch settles and resets on the
      // host's own close path exactly as it does today.
      resolveStep(pendingStep(), "closed");
      // With nothing in flight the batch settles right here; an active
      // request settles it when its own outcome lands.
      if (active === null) {
        settleIfDone();
      }
      publish();
      return stopped;
    },
    reset: () => {
      // Never drop a live request's record, nor a pending step's.
      if (active !== null || pendingStep()) return;
      entries = [];
      settled = false;
      dismissed = false;
      tables = [];
      skips = [];
      publish();
    },
    registerMatchingGate: (next) => {
      gate = next;
      return () => {
        if (gate !== next) return;
        gate = null;
        // Nobody is left to answer a pending step: it closes plain and
        // the batch goes on (plan risk 2). With no step pending the
        // release touches nothing: an active request answers on its
        // own and the batch settles on that outcome, never before it, and a file queued behind it
        // stays queued (the dialog's StrictMode rehearsal of this gate
        // over a running drop-anywhere batch, browser item b).
        const step = pendingStep();
        if (!step) return;
        resolveStep(step, "closed");
        startNext();
      };
    },
    resolveMatching: (id, outcome) => {
      const entry = entries.find((e) => e.id === id) ?? null;
      if (entry?.state !== "matching") {
        // Already resolved plain by a dismissal or a release: the batch
        // is not touched, but a set that committed after all still
        // changes what the listing says.
        if (outcome === "confirmed") options.onListingStale?.();
        return;
      }
      resolveStep(entry, outcome);
      startNext();
    },
  };

  function resolveStep(entry: EngineEntry | null, outcome: "confirmed" | "closed") {
    if (!entry || entry.state !== "matching") return;
    entry.state = "imported";
    entry.held = null;
    // A confirmed step changed the table after it landed: the host
    // re-reads its listing through the channel it already wires, never
    // through the landing notice again.
    if (outcome === "confirmed") options.onListingStale?.();
  }
}
