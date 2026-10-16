import { describe, expect, it } from "vitest";
import { thumbnailBody } from "./thumbnail-body";

const SENTENCE = "The snapshot must be a PNG of at most 4 MB.";
const MiB = 1024 * 1024;
const BOUND = 4 * MiB;

/** A body that hands out one chunk per pull and records how far it was read. */
function countedBody(sizes: number[]) {
  const seen = { pulls: 0, bytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = sizes[seen.pulls];
      if (size === undefined) { controller.close(); return; }
      seen.pulls++; seen.bytes += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { seen, request: (headers: Record<string, string> = {}) =>
    new Request("http://instance.test/api/maps/m/thumbnail", { method: "PUT", headers, body: stream, duplex: "half" } as RequestInit) };
}

/** The admitted length or the refusal, never the bytes themselves. */
const outcome = (reading: Promise<Uint8Array>) =>
  reading.then(body => ({ admitted: body.byteLength }), (error: { code?: string; status?: number; message?: string }) =>
    ({ code: error.code, status: error.status, message: error.message }));
const refusal = { code: "request_body_too_large", status: 413, message: SENTENCE };

describe("binary snapshot admission", () => {
  it("admits a body of exactly the bound, read whole", async () => {
    const body = countedBody([MiB, MiB, MiB, MiB]);
    expect(await outcome(thumbnailBody(body.request()))).toEqual({ admitted: BOUND });
    expect(body.seen).toEqual({ pulls: 4, bytes: BOUND, cancelled: false });
  });

  it("refuses on the crossing chunk without pulling the unread tail", async () => {
    const tail = Array.from({ length: 60 }, () => MiB);
    const body = countedBody([MiB, MiB, MiB, MiB, 1, ...tail]);
    expect(await outcome(thumbnailBody(body.request()))).toEqual(refusal);
    // Four admitted chunks and the one byte that crosses; none of the 60 MiB after it.
    expect(body.seen).toEqual({ pulls: 5, bytes: BOUND + 1, cancelled: true });
  });

  it("refuses a declared length past the bound before reading anything", async () => {
    const body = countedBody([MiB]);
    expect(await outcome(thumbnailBody(body.request({ "content-length": String(BOUND + 1) })))).toEqual(refusal);
    expect(body.seen.pulls).toBe(0);
  });

  it("counts arriving bytes, whatever a low declared length says", async () => {
    const body = countedBody([MiB, MiB, MiB, MiB, MiB]);
    expect(await outcome(thumbnailBody(body.request({ "content-length": "8" })))).toEqual(refusal);
    expect(body.seen.pulls).toBe(5);
  });
});
