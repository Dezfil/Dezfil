import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { receiveUpload, type ReceptionBounds } from "./receive";

/**
 * A caller may bound a reception by its own numbers and word its own
 * refusals: the file part, the whole body counted as it arrives, the time
 * to receive. The table upload's bounds stay the instance's settings,
 * which the receiver's other suites hold.
 */

const root = process.env.DEZFIL_DATA_DIR!;
let data: string;
beforeEach(() => {
  data = mkdtempSync(path.join(root, "receive-bounds-"));
  vi.stubEnv("DEZFIL_DATA_DIR", data);
});
afterEach(() => { vi.unstubAllEnvs(); });

const bounds = (over: Partial<ReceptionBounds> = {}): ReceptionBounds => ({
  fileBytes: 1024,
  bodyBytes: 1024 + 4096,
  receiveMs: 60_000,
  tooLarge: () => "The file is over the fixed limit.",
  timeoutRemedy: "The limit is fixed.",
  ...over,
});
const staged = () => readdir(path.join(data, "tmp")).catch(() => []);
const head = (boundary: string, filename = "face.png") =>
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
  "Content-Type: application/octet-stream\r\n\r\n";

function multipart(content: Uint8Array | string, extra?: [string, string]): Request {
  const form = new FormData();
  if (extra) form.append(extra[0], extra[1]);
  form.append("file", new Blob([content as BlobPart]), "face.png");
  return new Request("http://dezfil.test/upload", { method: "PUT", body: form });
}

/** A body that sends what it is given and then waits, never finishing. */
function streaming(chunks: string[], headers: Record<string, string> = {}) {
  let pulls = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[pulls++];
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else return new Promise<void>(() => {});
    },
  });
  const request = new Request("http://dezfil.test/upload", {
    method: "PUT", body, duplex: "half",
    headers: { "content-type": "multipart/form-data; boundary=edge", ...headers },
  } as RequestInit);
  return { request, pulled: () => pulls };
}

describe("receiveUpload with a caller's bounds", () => {
  it("accepts a file at exactly its file bound", async () => {
    const received = await receiveUpload(multipart(new Uint8Array(1024).fill(7)), undefined, bounds());
    expect(received.filename).toBe("face.png");
    expect((await readFile(received.tmpPath)).byteLength).toBe(1024);
  });

  it("refuses a file one byte over its file bound with the caller's wording", async () => {
    await expect(receiveUpload(multipart(new Uint8Array(1025).fill(7)), undefined, bounds()))
      .rejects.toMatchObject({ code: "upload_too_large", status: 413, message: "The file is over the fixed limit." });
    expect(await staged()).toEqual([]);
  });

  it("cuts off a body over its bound whose file part is small, counting what arrives", async () => {
    // The envelope is the bound here: a large ordinary field ahead of a
    // small file, with no declared length.
    const { request } = streaming([
      `--edge\r\nContent-Disposition: form-data; name="note"\r\n\r\n${"n".repeat(8192)}\r\n`,
      head("edge") + "tiny",
    ]);
    await expect(receiveUpload(request, undefined, bounds()))
      .rejects.toMatchObject({ code: "upload_too_large", status: 413, message: "The file is over the fixed limit." });
    expect(await staged()).toEqual([]);
  });

  it("cuts off a body that declares a shorter length than it sends", async () => {
    const { request } = streaming([head("edge"), "x".repeat(4096), "x".repeat(4096)], { "content-length": "200" });
    await expect(receiveUpload(request, undefined, bounds({ fileBytes: 1 << 20 })))
      .rejects.toMatchObject({ code: "upload_too_large", status: 413 });
    expect(await staged()).toEqual([]);
  });

  it("refuses a declared length over the body bound before reading the body", async () => {
    const { request, pulled } = streaming([head("edge"), "x"], { "content-length": String(1024 + 4096 + 1) });
    await expect(receiveUpload(request, undefined, bounds()))
      .rejects.toMatchObject({ code: "upload_too_large", status: 413, message: "The file is over the fixed limit." });
    // At most the stream's own first pull ran: nothing was asked of it
    // after the refusal.
    expect(pulled()).toBeLessThanOrEqual(1);
    expect(await staged()).toEqual([]);
  });

  it("ends a reception at the caller's time with the caller's remedy", async () => {
    const { request } = streaming([head("edge"), "partial"]);
    await expect(receiveUpload(request, undefined, bounds({ receiveMs: 150 })))
      .rejects.toMatchObject({
        code: "data_processing_timeout", status: 408,
        message: "Upload exceeded the 0.15 s reception time limit. The limit is fixed.",
      });
    expect(await staged()).toEqual([]);
  });

  it("keeps the table upload's own wording when no bounds are given", async () => {
    vi.stubEnv("DEZFIL_UPLOAD_MAX_MB", "1");
    await expect(receiveUpload(multipart(new Uint8Array(2 * 1024 * 1024))))
      .rejects.toMatchObject({ code: "upload_too_large", status: 413, message: expect.stringMatching(/^Upload exceeds the size cap of 1 MB\. /) });
  });
});
