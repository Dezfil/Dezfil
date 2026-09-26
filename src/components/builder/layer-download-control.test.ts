import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveLayerDownloadPreparationTimeoutMs,
  LayerDownloadPrepareOwnership,
  LayerDownloadStatusObservations,
  LAYER_DOWNLOAD_RESPONSE_MARGIN_MS,
  LAYER_DOWNLOAD_STATUS_OBSERVATION_TIMEOUT_MS,
  MAX_CONSECUTIVE_UNCONFIRMED_STATUS_OBSERVATIONS,
  startLayerDownloadControlRequest,
  startLayerDownloadPreparation,
} from "./layer-download-control";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const TICKET = "t".repeat(32);

function ticketResponse(ticket = TICKET): Response {
  return Response.json({ ticket });
}

function heldTicketBody(): {
  responseFor: (signal: AbortSignal) => Response;
  answer: (ticket?: string) => void;
  aborted: () => boolean;
} {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let aborted = false;
  return {
    responseFor: (signal) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          const abort = () => {
            aborted = true;
            controller.error(new Error("ticket body transport aborted"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    answer: (ticket = TICKET) => {
      body.enqueue(new TextEncoder().encode(JSON.stringify({ ticket })));
      body.close();
    },
    aborted: () => aborted,
  };
}

function preparationHarness(
  fetchControl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  timeoutMs = 90_000,
) {
  const state = {
    current: true,
    active: true,
    failures: [] as string[],
    tickets: [] as string[],
    releases: [] as string[],
  };
  const preparation = startLayerDownloadPreparation({
    url: "/api/layers/layer-1/export/csv?__ui_prepare=1",
    timeoutMs,
    fetchControl,
    readFailureMessage: async () => "safe coded failure",
    networkMessage: "safe network recovery",
    invalidMessage: "safe internal recovery",
    isCurrent: () => state.current,
    onFailure: (message) => {
      state.active = false;
      state.failures.push(message);
    },
    onTicket: (ticket) => {
      state.active = false;
      state.tickets.push(ticket);
    },
    releaseTicket: (ticket) => state.releases.push(ticket),
  });
  return { preparation, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("layer-download control bounds", () => {
  it("derives the default and non-default preparation bounds from the query budget", () => {
    expect(LAYER_DOWNLOAD_RESPONSE_MARGIN_MS).toBe(30_000);
    expect(deriveLayerDownloadPreparationTimeoutMs(60_000)).toBe(90_000);
    expect(deriveLayerDownloadPreparationTimeoutMs(12_500)).toBe(42_500);
    expect(() => deriveLayerDownloadPreparationTimeoutMs(0)).toThrow(
      RangeError,
    );
  });

  it("settles a request held before response headers at the default boundary", async () => {
    vi.useFakeTimers();
    const held = deferred<string>();
    let requestSignal!: AbortSignal;
    const request = startLayerDownloadControlRequest(
      (signal) => {
        requestSignal = signal;
        return held.promise;
      },
      { timeoutMs: deriveLayerDownloadPreparationTimeoutMs(60_000) },
    );
    let settled = false;
    void request.outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    expect(requestSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request.outcome).resolves.toEqual({ kind: "timed-out" });
    expect(requestSignal.aborted).toBe(true);
  });

  it("uses one total preparation clock across headers and the complete body", async () => {
    vi.useFakeTimers();
    const headers = deferred<void>();
    const body = deferred<string>();
    let bodyStarted = false;
    const request = startLayerDownloadControlRequest(
      async () => {
        await headers.promise;
        bodyStarted = true;
        return body.promise;
      },
      { timeoutMs: deriveLayerDownloadPreparationTimeoutMs(60_000) },
    );
    let settled = false;
    void request.outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    headers.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(bodyStarted).toBe(true);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request.outcome).resolves.toEqual({ kind: "timed-out" });
  });

  it("keeps post-header departure silent and routes the boundary abort rejection as late", async () => {
    vi.useFakeTimers();
    const headers = deferred<void>();
    const body = deferred<string>();
    const ownership = new LayerDownloadPrepareOwnership();
    const release = vi.fn();
    const lateRejected = vi.fn();
    const transportAbort = new Error("body transport aborted");
    const request = startLayerDownloadControlRequest(
      async (signal) => {
        signal.addEventListener("abort", () => body.reject(transportAbort), {
          once: true,
        });
        await headers.promise;
        ownership.markHeadersReceived();
        return body.promise;
      },
      {
        timeoutMs: 90_000,
        onLateResolved: (ticket) => {
          ownership.acceptTicket(() => release(ticket));
        },
        onLateRejected: lateRejected,
      },
    );
    let settled = false;
    void request.outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    headers.resolve();
    await vi.advanceTimersByTimeAsync(0);
    ownership.depart(request.cancel);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(ownership.isDeparted).toBe(true);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request.outcome).resolves.toEqual({ kind: "timed-out" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateRejected).toHaveBeenCalledWith(transportAbort);
    expect(release).not.toHaveBeenCalled();
  });

  it("honors a non-default server budget without an early client cutoff", async () => {
    vi.useFakeTimers();
    const held = deferred<string>();
    const request = startLayerDownloadControlRequest(() => held.promise, {
      timeoutMs: deriveLayerDownloadPreparationTimeoutMs(12_500),
    });
    let settled = false;
    void request.outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(42_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request.outcome).resolves.toEqual({ kind: "timed-out" });
  });

  it("routes an abort rejection to onLateRejected after terminal timeout", async () => {
    vi.useFakeTimers();
    const abortRejection = new Error("transport aborted");
    const lateRejected = vi.fn();
    const request = startLayerDownloadControlRequest(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortRejection), {
            once: true,
          });
        }),
      {
        timeoutMs: LAYER_DOWNLOAD_STATUS_OBSERVATION_TIMEOUT_MS,
        onLateRejected: lateRejected,
      },
    );

    await vi.advanceTimersByTimeAsync(
      LAYER_DOWNLOAD_STATUS_OBSERVATION_TIMEOUT_MS,
    );
    await expect(request.outcome).resolves.toEqual({ kind: "timed-out" });
    expect(lateRejected).toHaveBeenCalledOnce();
    expect(lateRejected).toHaveBeenCalledWith(abortRejection);
  });

  it("cancels with request-local transport ownership", async () => {
    const lifetime = new AbortController();
    let requestSignal!: AbortSignal;
    const request = startLayerDownloadControlRequest(
      (signal) => {
        requestSignal = signal;
        return new Promise<never>(() => {});
      },
      { timeoutMs: 90_000, cancellationSignal: lifetime.signal },
    );

    lifetime.abort();

    await expect(request.outcome).resolves.toEqual({ kind: "cancelled" });
    expect(requestSignal.aborted).toBe(true);
  });

  it("observes late resolution and rejection without changing terminal outcomes", async () => {
    vi.useFakeTimers();
    const lateValue = deferred<string>();
    const lateError = deferred<string>();
    const onLateResolved = vi.fn(() =>
      Promise.reject(new Error("late cleanup failed")),
    );
    const onLateRejected = vi.fn(() =>
      Promise.reject(new Error("late rejection observer failed")),
    );
    const resolvedRequest = startLayerDownloadControlRequest(
      () => lateValue.promise,
      { timeoutMs: 5_000, onLateResolved },
    );
    const rejectedRequest = startLayerDownloadControlRequest(
      () => lateError.promise,
      { timeoutMs: 5_000, onLateRejected },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(resolvedRequest.outcome).resolves.toEqual({
      kind: "timed-out",
    });
    await expect(rejectedRequest.outcome).resolves.toEqual({
      kind: "timed-out",
    });

    const rejection = new Error("late operation rejection");
    lateValue.resolve("late-ticket");
    lateError.reject(rejection);
    await vi.advanceTimersByTimeAsync(0);

    expect(onLateResolved).toHaveBeenCalledWith("late-ticket");
    expect(onLateRejected).toHaveBeenCalledWith(rejection);
  });

  it("keeps distinct control requests independently settled", async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstRequest = startLayerDownloadControlRequest(() => first.promise, {
      timeoutMs: 5_000,
    });
    const secondRequest = startLayerDownloadControlRequest(
      () => second.promise,
      { timeoutMs: 10_000 },
    );
    let secondSettled = false;
    void secondRequest.outcome.then(() => {
      secondSettled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(firstRequest.outcome).resolves.toEqual({ kind: "timed-out" });
    expect(secondSettled).toBe(false);

    second.resolve("second-ticket");
    await expect(secondRequest.outcome).resolves.toEqual({
      kind: "resolved",
      value: "second-ticket",
    });
  });
});

describe("layer-download preparation coordinator", () => {
  it("invokes browser-native fetch without rebinding its receiver", async () => {
    function receiverSensitiveFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      expect(String(input)).toContain("__ui_prepare=1");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(ticketResponse());
    }
    const run = preparationHarness(receiverSensitiveFetch);

    await expect(run.preparation.outcome).resolves.toEqual({ kind: "ticket" });
    expect(run.state.tickets).toEqual([TICKET]);
  });

  it("times out the real pre-header road, removes active state, releases a late ticket, and permits Retry", async () => {
    vi.useFakeTimers();
    const firstResponse = deferred<Response>();
    let firstSignal!: AbortSignal;
    const first = preparationHarness((_input, init) => {
      firstSignal = init!.signal as AbortSignal;
      return firstResponse.promise;
    });

    await vi.advanceTimersByTimeAsync(89_999);
    expect(first.state.active).toBe(true);
    expect(first.state.failures).toEqual([]);
    expect(firstSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(first.preparation.outcome).resolves.toEqual({
      kind: "timed-out",
      announced: true,
    });
    expect(firstSignal.aborted).toBe(true);
    expect(first.state.active).toBe(false);
    expect(first.state.failures).toEqual(["safe network recovery"]);

    // The transport ignored abort and answered after the active action had
    // already recovered. The same production coordinator owns this late road.
    firstResponse.resolve(ticketResponse("l".repeat(32)));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state.tickets).toEqual([]);
    expect(first.state.releases).toEqual(["l".repeat(32)]);

    const retry = preparationHarness(async () =>
      ticketResponse("r".repeat(32)),
    );
    await expect(retry.preparation.outcome).resolves.toEqual({
      kind: "ticket",
    });
    expect(retry.state.tickets).toEqual(["r".repeat(32)]);
    expect(retry.state.failures).toEqual([]);
  });

  it("bounds the real successful-header ticket body and leaves an unseen ticket to server ownership", async () => {
    vi.useFakeTimers();
    const held = heldTicketBody();
    let requestSignal!: AbortSignal;
    const run = preparationHarness(async (_input, init) => {
      requestSignal = init!.signal as AbortSignal;
      return held.responseFor(requestSignal);
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(run.state.active).toBe(true);
    expect(run.state.failures).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run.preparation.outcome).resolves.toEqual({
      kind: "timed-out",
      announced: true,
    });
    expect(requestSignal.aborted).toBe(true);
    expect(held.aborted()).toBe(true);
    expect(run.state.active).toBe(false);
    expect(run.state.failures).toEqual(["safe network recovery"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.state.tickets).toEqual([]);
    expect(run.state.releases).toEqual([]);
  });

  it("keeps post-header departure silent through its original boundary", async () => {
    vi.useFakeTimers();
    const held = heldTicketBody();
    let requestSignal!: AbortSignal;
    const run = preparationHarness(async (_input, init) => {
      requestSignal = init!.signal as AbortSignal;
      return held.responseFor(requestSignal);
    });
    await vi.advanceTimersByTimeAsync(60_000);

    run.state.current = false;
    run.state.active = false;
    run.preparation.depart();
    expect(requestSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(run.preparation.outcome).resolves.toEqual({
      kind: "timed-out",
      announced: false,
    });
    expect(requestSignal.aborted).toBe(true);
    expect(run.state.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.aborted()).toBe(true);
    expect(run.state.tickets).toEqual([]);
    expect(run.state.failures).toEqual([]);
    expect(run.state.releases).toEqual([]);
  });

  it("releases a post-header ticket that arrives after departure but before the original boundary", async () => {
    vi.useFakeTimers();
    const held = heldTicketBody();
    let requestSignal!: AbortSignal;
    const run = preparationHarness(async (_input, init) => {
      requestSignal = init!.signal as AbortSignal;
      return held.responseFor(requestSignal);
    });
    await vi.advanceTimersByTimeAsync(60_000);

    run.state.current = false;
    run.state.active = false;
    run.preparation.depart();
    expect(requestSignal.aborted).toBe(false);

    // Simulate A → B → A before the still-bounded body resolves. The
    // departed coordinator may see the old map id again, but only releases.
    run.state.current = true;
    await vi.advanceTimersByTimeAsync(29_999);
    held.answer("a".repeat(32));
    await vi.advanceTimersByTimeAsync(0);

    await expect(run.preparation.outcome).resolves.toEqual({
      kind: "released",
    });
    expect(requestSignal.aborted).toBe(false);
    expect(held.aborted()).toBe(false);
    expect(run.state.tickets).toEqual([]);
    expect(run.state.failures).toEqual([]);
    expect(run.state.releases).toEqual(["a".repeat(32)]);
  });
});

describe("layer-download preparation ownership", () => {
  it("cancels work when departure precedes response headers", () => {
    const ownership = new LayerDownloadPrepareOwnership();
    const cancel = vi.fn();

    ownership.depart(cancel);

    expect(ownership.isDeparted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("observes a post-header body and releases its late ticket after departure", () => {
    const ownership = new LayerDownloadPrepareOwnership();
    const cancel = vi.fn();
    const release = vi.fn();

    ownership.markHeadersReceived();
    ownership.depart(cancel);

    expect(cancel).not.toHaveBeenCalled();
    expect(ownership.acceptTicket(release)).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("transfers a ticket while the builder still owns the action", () => {
    const ownership = new LayerDownloadPrepareOwnership();
    const release = vi.fn();

    ownership.markHeadersReceived();

    expect(ownership.acceptTicket(release)).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("layer-download status observations", () => {
  it("requires three consecutive unconfirmed observations", () => {
    const observations = new LayerDownloadStatusObservations();

    expect(MAX_CONSECUTIVE_UNCONFIRMED_STATUS_OBSERVATIONS).toBe(3);
    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(false);
    expect(observations.recordUnconfirmed()).toBe(true);
    expect(observations.consecutiveUnconfirmed).toBe(3);
  });

  it("resets only the exact action after a valid observation", () => {
    const first = new LayerDownloadStatusObservations();
    const second = new LayerDownloadStatusObservations();

    first.recordUnconfirmed();
    first.recordUnconfirmed();
    second.recordUnconfirmed();
    second.recordUnconfirmed();
    first.recordValid();

    expect(first.consecutiveUnconfirmed).toBe(0);
    expect(first.recordUnconfirmed()).toBe(false);
    expect(second.consecutiveUnconfirmed).toBe(2);
    expect(second.recordUnconfirmed()).toBe(true);
  });
});
