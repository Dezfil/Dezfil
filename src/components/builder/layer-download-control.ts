export const LAYER_DOWNLOAD_RESPONSE_MARGIN_MS = 30_000;
export const LAYER_DOWNLOAD_STATUS_OBSERVATION_TIMEOUT_MS = 5_000;
export const MAX_CONSECUTIVE_UNCONFIRMED_STATUS_OBSERVATIONS = 3;

export function deriveLayerDownloadPreparationTimeoutMs(
  queryTimeoutMs: number,
): number {
  if (!Number.isFinite(queryTimeoutMs) || queryTimeoutMs <= 0) {
    throw new RangeError("The layer-download query timeout must be positive.");
  }
  return queryTimeoutMs + LAYER_DOWNLOAD_RESPONSE_MARGIN_MS;
}

export type LayerDownloadControlOutcome<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timed-out" }
  | { kind: "cancelled" };

export interface LayerDownloadControlRequest<T> {
  outcome: Promise<LayerDownloadControlOutcome<T>>;
  cancel: () => void;
}

export interface LayerDownloadControlRequestOptions<T> {
  timeoutMs: number;
  cancellationSignal?: AbortSignal;
  onLateResolved?: (value: T) => void | Promise<void>;
  onLateRejected?: (error: unknown) => void | Promise<void>;
}

function observeLateCallback(callback: () => void | Promise<void>): void {
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // A late cleanup callback cannot change the request's terminal outcome.
  }
}

/**
 * Bounds one small control request without imposing a deadline on the native
 * file transfer. The terminal reason is recorded before transport abort, so a
 * synchronous abort rejection cannot replace a timeout or cancellation.
 */
export function startLayerDownloadControlRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: LayerDownloadControlRequestOptions<T>,
): LayerDownloadControlRequest<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("A layer-download control timeout must be positive.");
  }

  const transport = new AbortController();
  let terminal = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveOutcome!: (outcome: LayerDownloadControlOutcome<T>) => void;
  const outcome = new Promise<LayerDownloadControlOutcome<T>>((resolve) => {
    resolveOutcome = resolve;
  });

  const cancellationSignal = options.cancellationSignal;
  const removeCancellationListener = () => {
    cancellationSignal?.removeEventListener("abort", cancel);
  };
  const finish = (result: LayerDownloadControlOutcome<T>): boolean => {
    if (terminal) return false;
    terminal = true;
    if (timer !== null) clearTimeout(timer);
    removeCancellationListener();
    resolveOutcome(result);
    return true;
  };
  function cancel(): void {
    if (!finish({ kind: "cancelled" })) return;
    transport.abort();
  }

  if (cancellationSignal?.aborted) {
    cancel();
    return { outcome, cancel };
  }
  cancellationSignal?.addEventListener("abort", cancel, { once: true });

  timer = setTimeout(() => {
    if (!finish({ kind: "timed-out" })) return;
    transport.abort();
  }, options.timeoutMs);

  let operation: Promise<T>;
  try {
    operation = Promise.resolve(run(transport.signal));
  } catch (error) {
    operation = Promise.reject(error);
  }
  void operation.then(
    (value) => {
      if (finish({ kind: "resolved", value })) return;
      if (options.onLateResolved) {
        observeLateCallback(() => options.onLateResolved!(value));
      }
    },
    (error: unknown) => {
      if (finish({ kind: "rejected", error })) return;
      if (options.onLateRejected) {
        observeLateCallback(() => options.onLateRejected!(error));
      }
    },
  );

  return { outcome, cancel };
}

/**
 * Tracks the narrow ownership hand-off between successful response headers
 * and the complete ticket body. Departure before headers cancels server work;
 * departure after headers observes the body until its existing boundary and
 * releases any ticket that arrives.
 */
export class LayerDownloadPrepareOwnership {
  private headersReceived = false;
  private departed = false;

  get isDeparted(): boolean {
    return this.departed;
  }

  markHeadersReceived(): void {
    this.headersReceived = true;
  }

  depart(cancel: () => void): void {
    this.departed = true;
    if (!this.headersReceived) cancel();
  }

  acceptTicket(release: () => void): boolean {
    if (!this.departed) return true;
    release();
    return false;
  }
}

/** A valid private status answer breaks a run of uncertain observations. */
export class LayerDownloadStatusObservations {
  private unconfirmed = 0;

  get consecutiveUnconfirmed(): number {
    return this.unconfirmed;
  }

  recordValid(): void {
    this.unconfirmed = 0;
  }

  recordUnconfirmed(): boolean {
    this.unconfirmed += 1;
    return this.unconfirmed >= MAX_CONSECUTIVE_UNCONFIRMED_STATUS_OBSERVATIONS;
  }
}

export type LayerDownloadPreparationSettlement =
  | { kind: "ticket" }
  | { kind: "failed"; reason: "api" | "invalid" }
  | { kind: "timed-out"; announced: boolean }
  | { kind: "rejected"; announced: boolean }
  | { kind: "cancelled" }
  | { kind: "released" };

interface LayerDownloadPreparationOptions {
  url: string;
  timeoutMs: number;
  fetchControl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readFailureMessage: (response: Response) => Promise<string>;
  networkMessage: string;
  invalidMessage: string;
  isCurrent: () => boolean;
  onFailure: (message: string) => void;
  onTicket: (ticket: string) => void;
  releaseTicket: (ticket: string) => void;
}

export interface LayerDownloadPreparation {
  outcome: Promise<LayerDownloadPreparationSettlement>;
  depart: () => void;
}

type LayerDownloadPreparationAnswer =
  | { kind: "api-failure"; message: string }
  | { kind: "invalid" }
  | { kind: "ticket"; ticket: string };

function ticketFromBody(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 &&
    typeof body.ticket === "string" &&
    body.ticket.length >= 20
    ? body.ticket
    : null;
}

/**
 * The actual bounded preparation coordinator used by the builder. It spans
 * response headers and the complete ticket envelope, owns timeout versus
 * departure presentation, and releases any ticket that arrives after the
 * active action has settled.
 */
export function startLayerDownloadPreparation(
  options: LayerDownloadPreparationOptions,
): LayerDownloadPreparation {
  const ownership = new LayerDownloadPrepareOwnership();
  // Browser-native fetch is receiver-sensitive. Detach the injected function
  // from the options object before invoking it, just as a direct global call.
  const fetchControl = options.fetchControl;
  const request =
    startLayerDownloadControlRequest<LayerDownloadPreparationAnswer>(
      async (signal) => {
        const response = await fetchControl(options.url, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) {
          return {
            kind: "api-failure",
            message: await options.readFailureMessage(response),
          };
        }
        ownership.markHeadersReceived();
        const body: unknown = await response.json().catch(() => null);
        const ticket = ticketFromBody(body);
        return ticket === null
          ? { kind: "invalid" }
          : { kind: "ticket", ticket };
      },
      {
        timeoutMs: options.timeoutMs,
        onLateResolved: (answer) => {
          if (answer.kind === "ticket") options.releaseTicket(answer.ticket);
        },
      },
    );

  const outcome = request.outcome.then(
    (settled): LayerDownloadPreparationSettlement => {
      if (settled.kind === "cancelled") return { kind: "cancelled" };
      if (settled.kind === "timed-out" || settled.kind === "rejected") {
        const announced = !ownership.isDeparted && options.isCurrent();
        if (announced) options.onFailure(options.networkMessage);
        return { kind: settled.kind, announced };
      }

      const answer = settled.value;
      if (answer.kind === "api-failure" || answer.kind === "invalid") {
        if (!ownership.isDeparted && options.isCurrent()) {
          options.onFailure(
            answer.kind === "api-failure"
              ? answer.message
              : options.invalidMessage,
          );
        }
        return {
          kind: "failed",
          reason: answer.kind === "api-failure" ? "api" : "invalid",
        };
      }

      const release = () => options.releaseTicket(answer.ticket);
      if (!ownership.acceptTicket(release) || !options.isCurrent()) {
        if (!ownership.isDeparted) release();
        return { kind: "released" };
      }
      options.onTicket(answer.ticket);
      return { kind: "ticket" };
    },
  );

  return {
    outcome,
    depart: () => ownership.depart(request.cancel),
  };
}
