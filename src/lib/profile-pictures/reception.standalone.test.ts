import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest, type ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { closeMetadataDb } from "@/lib/metadata/db";
import { wideJpeg } from "../../../test-support/profile-picture-fixtures";

/** Run against a production standalone with the ingress preload and the same
 * fresh DEZFIL_DATA_DIR. Provisioning and the exact failing seed are in
 * reception.standalone.md beside this file. No listener or build is started by this suite. */
const port = process.env.DEZFIL_PICTURE_RECEPTION_PORT;
const LIMIT = 10 * 1024 * 1024;
const prefix = Buffer.from('--picture\r\nContent-Disposition: form-data; name="file"; filename="portrait.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
const ending = Buffer.from("\r\n--picture--\r\n");
interface Answer { status: number; json: { error?: { code: string; message: string }; account?: { pictureVersion?: string } }; elapsed: number }

describe.skipIf(!port)("production picture reception", () => {
  let authorization: string, root: string, exact: Buffer;
  const requests = new Set<ClientRequest>();
  const base = `http://127.0.0.1:${port}`;
  function start(maximum = 30000) {
    const started = performance.now(), test = expect.getState().currentTestName;
    const completed = Promise.withResolvers<Answer>();
    let done = false;
    const req = httpRequest(`${base}/api/account/picture`, { method: "PUT", headers: { authorization, "content-type": "multipart/form-data; boundary=picture", "transfer-encoding": "chunked" } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; }); res.on("error", completed.reject);
      res.on("end", () => {
        done = true;
        try {
          const answer = { status: res.statusCode!, json: JSON.parse(text), elapsed: performance.now() - started };
          // The measured answer time per case, for the record of a run.
          console.info(JSON.stringify({ test, status: answer.status, code: answer.json.error?.code ?? null, elapsedMs: Math.round(answer.elapsed) }));
          completed.resolve(answer);
        }
        catch { completed.reject(new Error(`Non-JSON response (${res.statusCode}): ${text.slice(0, 200)}`)); }
      });
    });
    requests.add(req); req.on("error", error => { if (!done) completed.reject(error); });
    req.flushHeaders();
    const timer = setTimeout(() => { completed.reject(new Error(`No complete JSON response within ${maximum} ms`)); req.destroy(); }, maximum);
    const result = completed.promise.finally(() => clearTimeout(timer)); void result.catch(() => {});
    return { req, result, done: () => done };
  }
  async function write(req: ClientRequest, bytes: Buffer) {
    if (req.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const clear = () => { req.off("drain", drained); req.off("response", drained); req.off("error", failed); req.off("close", closed); };
      const drained = () => { clear(); resolve(); };
      const failed = (error: Error) => { clear(); reject(error); };
      const closed = () => failed(new Error("Sender closed before its bytes drained."));
      req.once("drain", drained); req.once("response", drained); req.once("error", failed); req.once("close", closed);
    });
  }
  async function partial() {
    for (let count = 0; count < 200; count++) {
      const files = await readdir(path.join(root, "tmp")).catch(() => []);
      if ((await Promise.all(files.map(file => stat(path.join(root, "tmp", file)).then(s => s.size).catch(() => 0)))).some(size => size > 0)) return;
      await delay(25);
    }
    throw new Error("No growing upload file reached the shared scratch directory.");
  }
  async function clean() {
    for (let count = 0; count < 200; count++) {
      if (!(await readdir(path.join(root, "tmp")).catch(() => [])).length) return;
      await delay(25);
    }
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  }
  async function account(): Promise<{ sqlName: string; pictureVersion?: string }> {
    const response = await fetch(`${base}/api/account`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    return ((await response.json()) as { account: { sqlName: string; pictureVersion?: string } }).account;
  }
  const current = async () => (await account()).pictureVersion;
  /** A whole upload of `file`, answered with the account. */
  async function set(file: Buffer): Promise<Answer> {
    const upload = start(); upload.req.end(Buffer.concat([prefix, file, ending]));
    return upload.result;
  }
  async function recovered(before: string | undefined) {
    const answer = await set(await wideJpeg());
    expect(answer.status).toBe(200); expect(answer.json.account?.pictureVersion).not.toBe(before);
    expect(answer.json.account?.pictureVersion).toBe(await current());
  }
  beforeAll(async () => {
    root = process.env.DEZFIL_DATA_DIR ?? "";
    if (!/dezfil-test-/.test(path.basename(root))) throw new Error("Use a fresh dezfil-test-* directory shared with the standalone.");
    if (!/^\d+$/.test(port ?? "")) throw new Error("DEZFIL_PICTURE_RECEPTION_PORT must name the running standalone's port.");
    closeMetadataDb(); authorization = authenticatedRequest().headers.get("authorization")!;
    const jpeg = await wideJpeg();
    exact = Buffer.concat([jpeg, Buffer.alloc(LIMIT - jpeg.length)]);
    expect(await current()).toBeUndefined();
  });
  afterAll(() => {
    for (const req of requests) req.destroy();
    closeMetadataDb();
  });

  it("sets a picture of exactly 10 MB sent as it arrives, and refuses one byte more with nothing changed (200, then 413 upload_too_large)", async () => {
    const accepted = await set(exact);
    expect(accepted.status).toBe(200);
    const version = accepted.json.account?.pictureVersion;
    expect(version).toBe(await current());
    const picture = await fetch(`${base}/api/accounts/${(await account()).sqlName}/picture?v=${version}`, { headers: { authorization } });
    expect(picture.status).toBe(200); expect(picture.headers.get("content-type")).toBe("image/webp");
    expect((await picture.arrayBuffer()).byteLength).toBeLessThan(64 * 1024);
    const over = await set(Buffer.concat([exact, Buffer.from([0])]));
    expect(over.status).toBe(413);
    expect(over.json.error).toEqual({ code: "upload_too_large", message: "The file is over the 10 MB limit for a picture, which is fixed. Choose a still JPEG, PNG or WebP image." });
    expect(await current()).toBe(version);
    await clean();
  }, 60000);

  it("delivers a size refusal to a sender that stops sending, then closes the connection (413 upload_too_large, <5 s)", async () => {
    const before = await current();
    const upload = start(10000);
    await write(upload.req, Buffer.concat([prefix, exact, Buffer.alloc(64 * 1024)]));
    const answer = await upload.result;
    expect(answer.status).toBe(413); expect(answer.json.error?.code).toBe("upload_too_large"); expect(answer.elapsed).toBeLessThan(5000);
    await delay(5100); expect(upload.req.socket?.destroyed).toBe(true);
    expect(await current()).toBe(before);
    await clean(); await recovered(before);
  }, 60000);

  it("changes nothing when the caller leaves before the body is received, and serves the next upload", async () => {
    const before = await current();
    const upload = start(10000);
    await write(upload.req, Buffer.concat([prefix, exact.subarray(0, LIMIT / 2)]));
    await partial();
    upload.req.destroy();
    await clean();
    expect(await current()).toBe(before);
    await recovered(before);
  }, 60000);

  // Silence meets the upload's own 60 s stall well inside the 120 s reception.
  it.each([false, true])("refuses first-byte or mid-body silence (mid-body=%s): 408 upload_stalled in 60–65 s, nothing changed", async midBody => {
    const before = await current();
    const upload = start(100000);
    if (midBody) { await write(upload.req, Buffer.concat([prefix, exact.subarray(0, 1024 * 1024)])); await partial(); }
    const answer = await upload.result;
    expect(answer.status).toBe(408); expect(answer.json.error?.code).toBe("upload_stalled");
    expect(answer.elapsed).toBeGreaterThanOrEqual(59000); expect(answer.elapsed).toBeLessThan(65000);
    expect(await current()).toBe(before);
    await clean(); await recovered(before);
  }, 100000);

  it("bounds a body still arriving at 120 s (408 data_processing_timeout, <125 s), nothing changed", async () => {
    const before = await current();
    const upload = start(160000); await write(upload.req, Buffer.concat([prefix, exact.subarray(0, 1024)]));
    let sent = 1024;
    const progress = setInterval(() => { if (!upload.done()) { upload.req.write(exact.subarray(sent, sent + 1024)); sent += 1024; } }, 10000);
    try {
      const answer = await upload.result; expect(answer.status).toBe(408);
      expect(answer.json.error).toEqual({ code: "data_processing_timeout", message: "Upload exceeded the 120 s reception time limit. The limit is fixed." });
      expect(answer.elapsed).toBeGreaterThanOrEqual(119000); expect(answer.elapsed).toBeLessThan(125000);
      expect(await current()).toBe(before);
      await clean(); await recovered(before);
    } finally { clearInterval(progress); }
  }, 160000);
});
