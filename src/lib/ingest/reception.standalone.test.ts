import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agent, request as httpRequest, type ClientRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { closeMetadataDb } from "@/lib/metadata/db";
import { csvFixture } from "../../../scripts/transport-probe-support.mjs";

/** Run against a production standalone with the ingress preload and the same
 * fresh DEZFIL_DATA_DIR. Provisioning and the exact failing seed are in
 * docs/self-host/configuration.md. No listener or build is started by this suite. */
const port = process.env.DEZFIL_UPLOAD_RECEPTION_PORT;
const prefix = Buffer.from('--receive\r\nContent-Disposition: form-data; name="file"; filename="points.csv"\r\nContent-Type: text/csv\r\n\r\n');
const ending = Buffer.from("\r\n--receive--\r\n");
interface Answer { status: number; json: { error?: { code: string; message: string }; rowCount?: number }; elapsed: number }

describe.skipIf(!port)("production upload reception", () => {
  let authorization: string, root: string;
  const requests = new Set<ClientRequest>();
  const base = `http://127.0.0.1:${port}`;
  async function settings(patch: Record<string, number | null>) {
    const response = await fetch(`${base}/api/instance/settings`, { method: "PATCH", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(patch), signal: AbortSignal.timeout(10000) });
    expect(response.status, await response.text()).toBe(200);
  }
  function start(target = "/api/tables", maximum = 65000, agent?: Agent) {
    const started = performance.now(), test = expect.getState().currentTestName;
    const completed = Promise.withResolvers<Answer>();
    let done = false;
    const req = httpRequest(`${base}${target}`, { method: "POST", agent, headers: { authorization, "content-type": "multipart/form-data; boundary=receive", "transfer-encoding": "chunked" } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; }); res.on("error", completed.reject);
      res.on("end", () => {
        done = true;
        try {
          const answer = { status: res.statusCode!, json: JSON.parse(text), elapsed: performance.now() - started };
          // The measured answer time per case, for the record of a run.
          console.info(JSON.stringify({ test, target, status: answer.status, code: answer.json.error?.code ?? null, elapsedMs: Math.round(answer.elapsed) }));
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
  async function healthy() {
    const started = performance.now();
    const response = await fetch(`${base}/api/tables`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200); await response.arrayBuffer(); expect(performance.now() - started).toBeLessThan(5000);
  }
  async function recovered(agent?: Agent) {
    const next = start("/api/tables", 30000, agent); next.req.end(Buffer.concat([prefix, Buffer.from("lon,lat\n1,2\n"), ending]));
    const answer = await next.result; expect(answer.status).toBe(201); expect(answer.json.rowCount).toBe(1); expect(answer.elapsed).toBeLessThan(30000);
    return next;
  }
  beforeAll(async () => {
    root = process.env.DEZFIL_DATA_DIR ?? "";
    if (!/^\/tmp\/dezfil-test-/.test(root)) throw new Error("Use a fresh /tmp/dezfil-test-* directory shared with the standalone.");
    if (!/^\d+$/.test(port ?? "")) throw new Error("DEZFIL_UPLOAD_RECEPTION_PORT must name the running standalone's port.");
    closeMetadataDb(); authorization = authenticatedRequest().headers.get("authorization")!;
    await healthy();
  });
  beforeEach(async () => { await settings({ dataProcessingTimeoutS: 3600, uploadMaxMb: 2048 }); });
  afterAll(async () => {
    for (const req of requests) req.destroy();
    try { if (authorization) await settings({ dataProcessingTimeoutS: null, uploadMaxMb: null }); }
    finally { closeMetadataDb(); }
  });

  it("accepts 22 MiB paced over 350 s (201, all rows, <410 s) beside an ordinary 300 s refusal (408 request_timeout, <305 s)", async () => {
    const upload = start("/api/tables", 410000), ordinary = start("/api/query", 305000);
    const fixture = csvFixture(22 * 1024 * 1024), chunks = [...fixture.chunks()];
    await write(upload.req, prefix);
    const sending = (async () => {
      const started = performance.now();
      for (let index = 0; index < chunks.length; index++) {
        await delay(Math.max(0, 350000 * index / (chunks.length - 1) - (performance.now() - started)));
        await write(upload.req, chunks[index]);
      }
      upload.req.end(ending);
    })();
    const both = Promise.all([upload.result, ordinary.result]); void both.catch(() => {});
    await partial(); await healthy(); await sending;
    const [accepted, refused] = await both;
    expect(accepted.status).toBe(201); expect(accepted.json.rowCount).toBe(fixture.rows);
    expect(accepted.elapsed).toBeGreaterThanOrEqual(350000); expect(accepted.elapsed).toBeLessThan(410000);
    expect(refused.status).toBe(408); expect(refused.json.error?.code).toBe("request_timeout");
    expect(refused.elapsed).toBeGreaterThanOrEqual(299000); expect(refused.elapsed).toBeLessThan(305000); await clean();
  }, 420000);

  it.each([false, true])("refuses first-byte or mid-body silence (mid-body=%s): 408 upload_stalled in 60–65 s", async midBody => {
    const upload = start();
    if (midBody) { await write(upload.req, Buffer.concat([prefix, Buffer.from("lon,lat\n1,2\n")])); await partial(); }
    const answer = await upload.result;
    expect(answer.status).toBe(408); expect(answer.json.error?.code).toBe("upload_stalled");
    expect(answer.elapsed).toBeGreaterThanOrEqual(59000); expect(answer.elapsed).toBeLessThan(65000);
    await clean(); await recovered();
  }, 100000);

  it("delivers a size refusal to a silent sender before closing (413 upload_too_large, <60 s), then recovers", async () => {
    await settings({ uploadMaxMb: 1 });
    const upload = start("/api/tables", 60000);
    await write(upload.req, Buffer.concat([prefix, Buffer.alloc(2 * 1024 * 1024, "x")]));
    const answer = await upload.result;
    expect(answer.status).toBe(413); expect(answer.json.error?.code).toBe("upload_too_large"); expect(answer.elapsed).toBeLessThan(60000);
    await delay(5100); expect(upload.req.socket?.destroyed).toBe(true);
    await clean(); await recovered();
  }, 95000);

  it("bounds continuous progress and preserves its first refusal (408 data_processing_timeout, reception 60 s, <65 s)", async () => {
    await settings({ dataProcessingTimeoutS: 60 });
    const upload = start(); await write(upload.req, Buffer.concat([prefix, Buffer.from("lon,lat\n")]));
    const progress = setInterval(() => { if (!upload.done()) upload.req.write("1,2\n"); }, 10000);
    try {
      const answer = await upload.result; expect(answer.status).toBe(408);
      expect(answer.json.error).toMatchObject({ code: "data_processing_timeout", message: expect.stringContaining("60 s reception") });
      expect(answer.elapsed).toBeGreaterThanOrEqual(59000); expect(answer.elapsed).toBeLessThan(65000);
      await clean(); await recovered();
    } finally { clearInterval(progress); }
  }, 100000);

  it("keeps a 120 s admitted budget after changing it to 60 s (201 at 70–100 s) and reuses a completed connection", async () => {
    await settings({ dataProcessingTimeoutS: 120 });
    const agent = new Agent({ keepAlive: true });
    try {
      const upload = start("/api/tables", 100000, agent); await write(upload.req, Buffer.concat([prefix, Buffer.from("lon,lat\n")]));
      await partial(); await settings({ dataProcessingTimeoutS: 60 });
      await delay(35000); await write(upload.req, Buffer.from("1,2\n")); await delay(35000); upload.req.end(ending);
      const answer = await upload.result; expect(answer.status).toBe(201); expect(answer.json.rowCount).toBe(1); expect(answer.elapsed).toBeGreaterThanOrEqual(70000); expect(answer.elapsed).toBeLessThan(100000);
      const next = await recovered(agent); expect(next.req.socket).toBe(upload.req.socket); await clean();
    } finally { agent.destroy(); }
  }, 135000);
});
