import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { LayerExportFile, LayerExportFormat } from "./layer-export";

/**
 * Private, process-local hand-off for builder downloads. The public
 * layer-export operation remains the bare attachment GET; this store only
 * keeps an already-produced scratch file alive long enough for a native
 * browser navigation to redeem it and for the builder to observe that stream.
 */

export const LAYER_DOWNLOAD_PREPARED_TTL_MS = 60_000;
export const LAYER_DOWNLOAD_TOMBSTONE_TTL_MS = 60_000;

export type LayerDownloadStatus =
  | "prepared"
  | "streaming"
  | "complete"
  | "failed";

export interface LayerDownloadBinding {
  layerId: string;
  format: LayerExportFormat;
}

export interface PreparedLayerDownload extends LayerExportFile {
  size: number;
}

interface TicketEntry {
  scope: AccountScope;
  accountId: string;
  binding: LayerDownloadBinding;
  file: PreparedLayerDownload;
  /** Whether the source is still the claimant's to be handed, asked on the
   * claim; absent, the ticket asks nothing beyond the account. */
  servable: (() => boolean) | null;
  status: LayerDownloadStatus;
  timer: ReturnType<typeof setTimeout> | null;
  prepareSignal: AbortSignal | null;
  prepareAbort: (() => void) | null;
  abortStream: (() => void) | null;
  cleanupPromise: Promise<void> | null;
}

export interface ClaimedLayerDownload {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  /** Installs the abort hook. False means the claim has already settled. */
  registerAbort: (abort: () => void) => boolean;
  complete: () => void;
  fail: () => void;
}

/**
 * Bind server-observable stream events to a claimed ticket. Node's `end` is
 * the completion boundary; every other close road is a failure. The signal
 * covers caller departure after the route has already returned its response.
 */
export function observeLayerDownloadStream(
  stream: Readable,
  signal: AbortSignal,
  claimed: ClaimedLayerDownload,
): boolean {
  let ended = false;
  const detachCaller = () => signal.removeEventListener("abort", callerDeparted);
  const callerDeparted = () => {
    claimed.fail();
    stream.destroy();
  };

  stream.once("end", () => {
    ended = true;
    detachCaller();
    claimed.complete();
  });
  stream.once("error", () => {
    detachCaller();
    claimed.fail();
  });
  stream.once("close", () => {
    detachCaller();
    if (!ended) claimed.fail();
  });
  signal.addEventListener("abort", callerDeparted, { once: true });

  if (!claimed.registerAbort(() => stream.destroy())) {
    detachCaller();
    return false;
  }
  if (signal.aborted) {
    callerDeparted();
    return false;
  }
  return true;
}

interface StoreOptions {
  preparedTtlMs?: number;
  tombstoneTtlMs?: number;
  createToken?: () => string;
}

export class LayerDownloadTicketStore {
  private readonly entries = new Map<string, TicketEntry>();
  private readonly preparedTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly createToken: () => string;

  constructor(options: StoreOptions = {}) {
    this.preparedTtlMs =
      options.preparedTtlMs ?? LAYER_DOWNLOAD_PREPARED_TTL_MS;
    this.tombstoneTtlMs =
      options.tombstoneTtlMs ?? LAYER_DOWNLOAD_TOMBSTONE_TTL_MS;
    this.createToken =
      options.createToken ?? (() => randomBytes(32).toString("base64url"));
  }

  prepare(
    scope: AccountScope,
    binding: LayerDownloadBinding,
    file: PreparedLayerDownload,
    signal?: AbortSignal,
    servable?: () => boolean,
  ): string {
    const accountId = requireAccountScope(scope);
    let ticket: string;
    do {
      ticket = this.createToken();
    } while (this.entries.has(ticket));

    const entry: TicketEntry = {
      scope, accountId,
      binding: { ...binding },
      file,
      servable: servable ?? null,
      status: "prepared",
      timer: null,
      prepareSignal: null,
      prepareAbort: null,
      abortStream: null,
      cleanupPromise: null,
    };
    this.entries.set(ticket, entry);
    this.arm(entry, this.preparedTtlMs, () => {
      if (this.entries.get(ticket) !== entry || entry.status !== "prepared") {
        return;
      }
      this.transferPrepareOwnership(entry);
      entry.status = "failed";
      void this.cleanup(entry);
      this.armTombstone(ticket, entry);
    });
    if (signal) {
      const abandon = () => this.abandonPreparation(ticket, entry);
      entry.prepareSignal = signal;
      entry.prepareAbort = abandon;
      signal.addEventListener("abort", abandon, { once: true });
      // Adding a listener to an already-aborted signal does not dispatch it.
      if (signal.aborted) abandon();
    }
    return ticket;
  }

  claim(
    scope: AccountScope,
    ticket: string,
    binding: LayerDownloadBinding,
  ): ClaimedLayerDownload | null {
    const entry = this.boundEntry(scope, ticket, binding);
    if (!entry || entry.status !== "prepared") return null;
    // The hand-over is where reach is asked again: a source that left the
    // claimant's reach since the ticket refuses the claim, and the prepared
    // file goes.
    if (entry.servable && !entry.servable()) {
      this.settle(ticket, entry, "failed");
      return null;
    }

    this.transferPrepareOwnership(entry);
    this.clearTimer(entry);
    entry.status = "streaming";

    const stillStreaming = () =>
      this.entries.get(ticket) === entry && entry.status === "streaming";
    return {
      path: entry.file.path,
      filename: entry.file.filename,
      contentType: entry.file.contentType,
      size: entry.file.size,
      registerAbort: (abort) => {
        try { requireAccountScope(entry.scope); } catch { this.settle(ticket, entry, "failed"); abort(); return false; }
        if (!stillStreaming()) {
          abort();
          return false;
        }
        entry.abortStream = abort;
        return true;
      },
      complete: () => {
        if (!stillStreaming()) return;
        try { requireAccountScope(entry.scope); } catch { this.settle(ticket, entry, "failed"); return; }
        this.settle(ticket, entry, "complete");
      },
      fail: () => {
        if (stillStreaming()) this.settle(ticket, entry, "failed");
      },
    };
  }

  status(
    scope: AccountScope,
    ticket: string,
    binding: LayerDownloadBinding,
  ): LayerDownloadStatus | null {
    const entry = this.boundEntry(scope, ticket, binding);
    if (!entry) return null;
    this.transferPrepareOwnership(entry);
    return entry.status;
  }

  async release(
    scope: AccountScope,
    ticket: string,
    binding: LayerDownloadBinding,
  ): Promise<boolean> {
    const entry = this.boundEntry(scope, ticket, binding);
    if (!entry) return false;

    // A native attachment may already be consuming the file. The UI's
    // best-effort release request accompanies component departure, but it
    // must not turn that departure into a truncation of the browser-owned
    // stream. Stream end/error/caller abort remains the settlement boundary.
    if (entry.status === "streaming") return true;

    this.transferPrepareOwnership(entry);
    this.entries.delete(ticket);
    this.clearTimer(entry);
    const abort = entry.abortStream;
    entry.abortStream = null;
    if (abort) {
      try {
        abort();
      } catch (error) {
        console.error("[layer export] stream release failed:", error);
      }
    }
    await this.cleanup(entry);
    return true;
  }

  /** Test/process shutdown helper; normal request code releases by ticket. */
  async dispose(): Promise<void> {
    const pending = [...this.entries.entries()].map(async ([ticket, entry]) => {
      this.transferPrepareOwnership(entry);
      this.entries.delete(ticket);
      this.clearTimer(entry);
      if (entry.abortStream) {
        try {
          entry.abortStream();
        } catch (error) {
          console.error("[layer export] stream release failed:", error);
        }
      }
      await this.cleanup(entry);
    });
    await Promise.all(pending);
  }

  private boundEntry(
    scope: AccountScope,
    ticket: string,
    binding: LayerDownloadBinding,
  ): TicketEntry | null {
    const accountId = requireAccountScope(scope);
    const entry = this.entries.get(ticket);
    if (
      !entry || entry.accountId !== accountId ||
      entry.binding.layerId !== binding.layerId ||
      entry.binding.format !== binding.format
    ) {
      return null;
    }
    return entry;
  }

  private settle(
    ticket: string,
    entry: TicketEntry,
    status: "complete" | "failed",
  ): void {
    this.transferPrepareOwnership(entry);
    entry.status = status;
    entry.abortStream = null;
    void this.cleanup(entry);
    this.armTombstone(ticket, entry);
  }

  private armTombstone(ticket: string, entry: TicketEntry): void {
    this.arm(entry, this.tombstoneTtlMs, () => {
      if (
        this.entries.get(ticket) === entry &&
        (entry.status === "complete" || entry.status === "failed")
      ) {
        this.entries.delete(ticket);
      }
    });
  }

  private abandonPreparation(ticket: string, entry: TicketEntry): void {
    if (this.entries.get(ticket) !== entry || entry.status !== "prepared") {
      return;
    }
    this.transferPrepareOwnership(entry);
    this.entries.delete(ticket);
    this.clearTimer(entry);
    void this.cleanup(entry);
  }

  private transferPrepareOwnership(entry: TicketEntry): void {
    if (entry.prepareSignal && entry.prepareAbort) {
      entry.prepareSignal.removeEventListener("abort", entry.prepareAbort);
    }
    entry.prepareSignal = null;
    entry.prepareAbort = null;
  }

  private arm(entry: TicketEntry, delayMs: number, callback: () => void): void {
    this.clearTimer(entry);
    const timer = setTimeout(callback, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    entry.timer = timer;
  }

  private clearTimer(entry: TicketEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private cleanup(entry: TicketEntry): Promise<void> {
    entry.cleanupPromise ??= entry.file.cleanup().catch((error: unknown) => {
      // Cleanup failure is operational detail; never return a path or raw
      // filesystem message through the private status protocol.
      console.error("[layer export] scratch cleanup failed:", error);
    });
    return entry.cleanupPromise;
  }
}

export const layerDownloadTickets = new LayerDownloadTicketStore();
