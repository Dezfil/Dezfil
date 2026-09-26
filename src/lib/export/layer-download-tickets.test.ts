import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAYER_DOWNLOAD_PREPARED_TTL_MS,
  LAYER_DOWNLOAD_TOMBSTONE_TTL_MS,
  LayerDownloadTicketStore,
  observeLayerDownloadStream,
  type LayerDownloadBinding,
  type PreparedLayerDownload,
} from "./layer-download-tickets";

const binding: LayerDownloadBinding = {
  layerId: "layer-1",
  format: "csv",
};

function prepared(
  cleanup: () => Promise<void> = vi.fn(async () => undefined),
): PreparedLayerDownload {
  return {
    path: "/private/scratch/export.csv",
    filename: "Stations.csv",
    contentType: "text/csv; charset=utf-8",
    size: 17,
    cleanup,
  };
}

async function closed(stream: PassThrough): Promise<void> {
  if (stream.closed) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }
  await new Promise<void>((resolve) => stream.once("close", resolve));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("layer download tickets — binding and one-use hand-off", () => {
  it("mints a high-entropy opaque token bound to one layer and format", async () => {
    const cleanup = vi.fn(async () => undefined);
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup));

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.status(ticket, binding)).toBe("prepared");
    expect(
      store.status(ticket, { layerId: "other", format: "csv" }),
    ).toBeNull();
    expect(
      store.claim(ticket, { layerId: "layer-1", format: "geojson" }),
    ).toBeNull();

    const claim = store.claim(ticket, binding);
    expect(claim).not.toBeNull();
    expect(store.status(ticket, binding)).toBe("streaming");
    expect(store.claim(ticket, binding)).toBeNull();
    claim!.complete();
    expect(store.status(ticket, binding)).toBe("complete");
    expect(cleanup).toHaveBeenCalledOnce();
    await store.dispose();
  });

  it("never interprets a hostile token as a filesystem path", async () => {
    const cleanup = vi.fn(async () => undefined);
    const store = new LayerDownloadTicketStore({ createToken: () => "safe" });
    const ticket = store.prepare(binding, prepared(cleanup));

    expect(store.claim("../../ids.env", binding)).toBeNull();
    expect(store.status("file:///etc/passwd", binding)).toBeNull();
    await expect(store.release("../safe", binding)).resolves.toBe(false);
    expect(cleanup).not.toHaveBeenCalled();

    await expect(store.release(ticket, binding)).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("abandons an unobserved preparation with the original request", async () => {
    const cleanup = vi.fn(async () => undefined);
    const controller = new AbortController();
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup), controller.signal);

    controller.abort();

    expect(store.status(ticket, binding)).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    await store.dispose();
  });

  it("a wrong-bound status observation does not transfer ownership", async () => {
    const cleanup = vi.fn(async () => undefined);
    const controller = new AbortController();
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup), controller.signal);

    expect(
      store.status(ticket, { layerId: "other", format: "csv" }),
    ).toBeNull();
    controller.abort();

    expect(store.status(ticket, binding)).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("a correctly bound status observation transfers ownership", async () => {
    const cleanup = vi.fn(async () => undefined);
    const controller = new AbortController();
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup), controller.signal);

    expect(store.status(ticket, binding)).toBe("prepared");
    controller.abort();

    expect(store.status(ticket, binding)).toBe("prepared");
    expect(cleanup).not.toHaveBeenCalled();
    await store.release(ticket, binding);
  });

  it("a correctly bound claim transfers ownership from the prepare signal", async () => {
    const cleanup = vi.fn(async () => undefined);
    const controller = new AbortController();
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup), controller.signal);

    expect(store.claim(ticket, binding)).not.toBeNull();
    controller.abort();

    expect(store.status(ticket, binding)).toBe("streaming");
    expect(cleanup).not.toHaveBeenCalled();
    await store.release(ticket, binding);
  });
});

describe("layer download tickets — expiry and release", () => {
  it("unrefs its runtime expiry reaper", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared());
    const timer = timerSpy.mock.results.at(-1)?.value as NodeJS.Timeout;

    expect(timer.hasRef()).toBe(false);
    await store.release(ticket, binding);
    timerSpy.mockRestore();
  });

  it("keeps an unused preparation through 59,999 ms and expires it at 60,000 ms", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup));

    await vi.advanceTimersByTimeAsync(LAYER_DOWNLOAD_PREPARED_TTL_MS - 1);
    expect(cleanup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(store.status(ticket, binding)).toBe("failed");
    expect(cleanup).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(LAYER_DOWNLOAD_TOMBSTONE_TTL_MS);
    expect(store.status(ticket, binding)).toBeNull();
    await store.dispose();
  });

  it("does not TTL-expire an active stream or release its file early", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    const abort = vi.fn();
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup));
    const claim = store.claim(ticket, binding)!;
    expect(claim.registerAbort(abort)).toBe(true);

    await vi.advanceTimersByTimeAsync(
      LAYER_DOWNLOAD_PREPARED_TTL_MS + LAYER_DOWNLOAD_TOMBSTONE_TTL_MS + 1,
    );
    expect(store.status(ticket, binding)).toBe("streaming");
    expect(cleanup).not.toHaveBeenCalled();

    await expect(store.release(ticket, binding)).resolves.toBe(true);
    expect(abort).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.status(ticket, binding)).toBe("streaming");
    await store.dispose();
    expect(abort).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps settled state for one tombstone window", async () => {
    vi.useFakeTimers();
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared());
    store.claim(ticket, binding)!.fail();

    expect(store.status(ticket, binding)).toBe("failed");
    await vi.advanceTimersByTimeAsync(LAYER_DOWNLOAD_TOMBSTONE_TTL_MS - 1);
    expect(store.status(ticket, binding)).toBe("failed");
    await vi.advanceTimersByTimeAsync(1);
    expect(store.status(ticket, binding)).toBeNull();
  });
});

describe("layer download tickets — stream truth", () => {
  function streamCase() {
    const cleanup = vi.fn(async () => undefined);
    const store = new LayerDownloadTicketStore();
    const ticket = store.prepare(binding, prepared(cleanup));
    const claim = store.claim(ticket, binding)!;
    const stream = new PassThrough();
    const controller = new AbortController();
    expect(observeLayerDownloadStream(stream, controller.signal, claim)).toBe(
      true,
    );
    return { cleanup, store, ticket, stream, controller };
  }

  it("marks complete only when the readable ends", async () => {
    const { cleanup, store, ticket, stream } = streamCase();
    stream.resume();
    stream.end("download bytes");
    await once(stream, "end");

    expect(store.status(ticket, binding)).toBe("complete");
    expect(cleanup).toHaveBeenCalledOnce();
    await closed(stream);
    await store.dispose();
  });

  it("marks a read error failed without an unhandled error", async () => {
    const { cleanup, store, ticket, stream } = streamCase();
    stream.destroy(new Error("seeded read failure"));
    await closed(stream);

    expect(store.status(ticket, binding)).toBe("failed");
    expect(cleanup).toHaveBeenCalledOnce();
    await store.dispose();
  });

  it("marks caller cancellation failed and destroys the stream", async () => {
    const { cleanup, store, ticket, stream, controller } = streamCase();
    controller.abort();
    await closed(stream);

    expect(stream.destroyed).toBe(true);
    expect(store.status(ticket, binding)).toBe("failed");
    expect(cleanup).toHaveBeenCalledOnce();
    await store.dispose();
  });

  it("keeps a held native stream alive when the client releases its ticket", async () => {
    const { cleanup, store, ticket, stream } = streamCase();
    stream.resume();
    stream.write("download bytes");

    await expect(store.release(ticket, binding)).resolves.toBe(true);

    expect(stream.destroyed).toBe(false);
    expect(store.status(ticket, binding)).toBe("streaming");
    expect(cleanup).not.toHaveBeenCalled();

    const ended = once(stream, "end");
    stream.end();
    await ended;

    expect(store.status(ticket, binding)).toBe("complete");
    expect(cleanup).toHaveBeenCalledOnce();
    await closed(stream);
    await store.dispose();
  });

  it("treats close before end as failure", async () => {
    const { cleanup, store, ticket, stream } = streamCase();
    stream.destroy();
    await closed(stream);

    expect(store.status(ticket, binding)).toBe("failed");
    expect(cleanup).toHaveBeenCalledOnce();
    await store.dispose();
  });
});
