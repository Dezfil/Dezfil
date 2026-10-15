import { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createUploadClock, receptionIterator } from "./reception.mjs";

afterEach(() => vi.useRealTimers());
it("cancels a pending native read without another byte or destroying its socket", async () => {
  const socket = new PassThrough() as unknown as Socket;
  const incoming = new IncomingMessage(socket), stops = new Set<() => void>();
  const iterator = receptionIterator(incoming, stops);
  const next = iterator.next().catch(error => error);
  await iterator.return!();
  expect(await next).toMatchObject({ name: "AbortError" });
  expect(socket.destroyed).toBe(false); expect(stops.size).toBe(0);
  incoming.destroy(); socket.destroy();
});
it("retains the first refusal through later progress, stall and cancellation", async () => {
  vi.useFakeTimers(); const notify = vi.fn(), first = Object.assign(new Error("size cap"), { status: 413, code: "upload_too_large" });
  const clock = createUploadClock(180000, "Settings > Limits", notify);
  clock.refuse(first); clock.progress(); clock.refuse(Object.assign(new Error("caller left"), { status: 499, code: null }));
  await vi.advanceTimersByTimeAsync(180001);
  expect(clock.failure).toBe(first); expect(notify).toHaveBeenCalledExactlyOnceWith(first);
  clock.complete(); expect(vi.getTimerCount()).toBe(0);
});
it("stops the idle clock at body end while destination settlement still owns the reception deadline", async () => {
  vi.useFakeTimers(); const notify = vi.fn();
  const clock = createUploadClock(120000, "Settings > Limits", notify); clock.endBody();
  await vi.advanceTimersByTimeAsync(119999); expect(notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ code: "data_processing_timeout", message: expect.stringContaining("120 s reception") }));
  clock.complete(); expect(vi.getTimerCount()).toBe(0);
});
