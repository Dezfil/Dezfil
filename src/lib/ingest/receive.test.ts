import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

/**
 * Regression suite: an upload's success is the durable write, not the end
 * of the transfer. The destination is swapped for slow and erroring
 * writables to open the exact gap the audit described.
 */

type StreamFactory = ((path: string) => Writable) | null;
let factory: StreamFactory = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (target: string) =>
      factory ? factory(target) : actual.createWriteStream(target),
  };
});

// Import after the mock so receive.ts binds the mocked createWriteStream.
const { receiveUpload } = await import("./receive");

/** Buffers every chunk and only writes the real file, late, at finalize —
 * the transfer ends long before the destination is durable. */
class SlowFile extends Writable {
  private chunks: Buffer[] = [];
  constructor(private readonly target: string) {
    super();
  }
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  override _final(cb: (error?: Error | null) => void) {
    setTimeout(() => {
      writeFileSync(this.target, Buffer.concat(this.chunks));
      cb();
    }, 120);
  }
}

/** Accepts the whole transfer, then fails at finalize — the flush error
 * that used to vanish behind an already-claimed success. */
class ExplodingFile extends Writable {
  override _write(
    _chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    cb();
  }
  override _final(cb: (error?: Error | null) => void) {
    setTimeout(() => cb(new Error("disk full")), 40);
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  factory = null;
});

afterEach(async () => {
  factory = null;
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function multipartRequest(content: string, filename = "points.csv"): Request {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  return new Request("http://dezfil.test/api/tables", {
    method: "POST",
    body: form,
  });
}

describe("receiveUpload", () => {
  it("streams an upload to a temp file and reports its name", async () => {
    const { tmpPath, filename } = await receiveUpload(
      multipartRequest("name,value\na,1\n"),
    );
    expect(filename).toBe("points.csv");
    await expect(readFile(tmpPath, "utf8")).resolves.toBe("name,value\na,1\n");
  });

  it("reports success only after a delayed destination write completes", async () => {
    factory = (target) => new SlowFile(target);
    const content = "name,value\n" + "x,1\n".repeat(500);
    const { tmpPath } = await receiveUpload(multipartRequest(content));
    // If success had been claimed at end-of-transfer, the file would not
    // exist yet — the slow destination writes it ~120 ms later.
    await expect(readFile(tmpPath, "utf8")).resolves.toBe(content);
  });

  it("surfaces a flush failure after the transfer ends, instead of success", async () => {
    factory = () => new ExplodingFile();
    await expect(
      receiveUpload(multipartRequest("name,value\na,1\n")),
    ).rejects.toMatchObject({ code: "internal", status: 500 });
    // The failed upload leaves nothing behind.
    await expect(readdir(path.join(dir, "data", "tmp"))).resolves.toEqual([]);
  });

  it("rejects a request with no file field", async () => {
    const form = new FormData();
    form.append("note", "no file here");
    const request = new Request("http://dezfil.test/api/tables", {
      method: "POST",
      body: form,
    });
    await expect(receiveUpload(request)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

/**
 * The strict singular contract: exactly one file part, named "file".
 * Both retired leniences — first-file-wins on a multi-part request, and
 * accepting the file under any field name — were confirmed against the
 * earlier receiver (the exploration probe), so each refusal here is
 * red-proven by construction: it fails on the lenient receiver.
 */
describe("receiveUpload — the singular contract", () => {
  it("refuses a request with two file parts and stages nothing", async () => {
    const form = new FormData();
    form.append("file", new Blob(["FIRST"]), "first.geojson");
    form.append("file", new Blob(["SECOND"]), "second.geojson");
    const request = new Request("http://dezfil.test/api/tables", {
      method: "POST",
      body: form,
    });
    await expect(receiveUpload(request)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    // The refusal is side-effect free: no staged bytes survive, so no
    // ingest could ever have been fed (the rule's no-artifact half).
    await expect(readdir(path.join(dir, "data", "tmp"))).resolves.toEqual([]);
  });

  it("refuses a file sent under another field name and stages nothing", async () => {
    const form = new FormData();
    form.append("data", new Blob(["CONTENT"]), "points.csv");
    const request = new Request("http://dezfil.test/api/tables", {
      method: "POST",
      body: form,
    });
    await expect(receiveUpload(request)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    await expect(readdir(path.join(dir, "data", "tmp"))).resolves.toEqual([]);
  });

  it("still accepts one file part named exactly \"file\"", async () => {
    const { filename, tmpPath } = await receiveUpload(
      multipartRequest("name,value\nb,2\n", "kept.csv"),
    );
    expect(filename).toBe("kept.csv");
    await expect(readFile(tmpPath, "utf8")).resolves.toBe("name,value\nb,2\n");
  });

  it("refuses an oversized file mid-stream with the documented cap answer", async () => {
    // The cap refusal an oversized batch member reports — the
    // batch-continuation half lives in the browser journey.
    process.env.DEZFIL_UPLOAD_MAX_MB = "1";
    try {
      await expect(
        receiveUpload(
          multipartRequest("x".repeat(2 * 1024 * 1024), "big.csv"),
        ),
      ).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
      await expect(
        readdir(path.join(dir, "data", "tmp")),
      ).resolves.toEqual([]);
    } finally {
      delete process.env.DEZFIL_UPLOAD_MAX_MB;
    }
  });

  it("keeps the size refusal when the caller leaves after it", async () => {
    process.env.DEZFIL_UPLOAD_MAX_MB = "1";
    const caller = new AbortController();
    const head = '--keep\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\n\r\n';
    // The sender is still sending when the cap is reached, and never finishes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(head + "x".repeat(2 * 1024 * 1024))); },
    });
    // The destination is still being torn down after the refusal when the caller leaves.
    const tearingDown = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    factory = () => new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      destroy(error, callback) { tearingDown.resolve(); void release.promise.then(() => callback(error)); },
    });
    try {
      const request = new Request("http://dezfil.test/api/tables", {
        method: "POST", body, signal: caller.signal, duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=keep" },
      } as RequestInit);
      const outcome = receiveUpload(request).catch((error: unknown) => error);
      await tearingDown.promise;
      caller.abort(); release.resolve();
      expect(await outcome).toMatchObject({ code: "upload_too_large", status: 413 });
      await expect(readdir(path.join(dir, "data", "tmp"))).resolves.toEqual([]);
    } finally {
      delete process.env.DEZFIL_UPLOAD_MAX_MB;
    }
  });
});
