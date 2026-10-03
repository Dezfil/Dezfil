import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { csvFixture, exchange, assertSmallRefusal, assertUpload, assertScratchGrowth, assertWorkflow, assertNoTruncation, LARGE_SENDER, SMALL_LIMIT } from "../../../scripts/transport-probe-support.mjs";

afterEach(() => vi.restoreAllMocks());
const tooLarge = { error: { code: "request_body_too_large", message: "The request body exceeds the 65536-byte limit." } };
const smallResult = (bytesAtStatus: number) => ({ status: 413, json: tooLarge, text: JSON.stringify(tooLarge), headers: { "cache-control": "private, no-store" }, bytesAtStatus });

it.each([11, 256])("emits an exact %s MiB CSV with independently counted complete rows", megabytes => {
  const fixture = csvFixture(megabytes * 1024 * 1024);
  let bytes = 0, newlines = 0, maxChunk = 0;
  for (const chunk of fixture.chunks()) {
    bytes += chunk.length; maxChunk = Math.max(maxChunk, chunk.length);
    for (const byte of chunk) if (byte === 10) newlines++;
  }
  expect(bytes).toBe(megabytes * 1024 * 1024);
  expect(newlines - 1).toBe(fixture.rows);
  expect(maxChunk).toBeLessThanOrEqual(65_536);
});

it("turns copy, truncation, missing-row, scratch and late-refusal defects red independently", () => {
  assertUpload({ status: 201, json: { rowCount: 10 }, text: "", headers: { "cache-control": "private, no-store" } }, 10);
  assertWorkflow({ status: 400, json: { error: { code: "invalid_request", message: '"name" must be a non-empty string.' } } });
  assertScratchGrowth([4096, 8192]); assertNoTruncation("Ready in 1s");
  assertSmallRefusal(smallResult(0), true); assertSmallRefusal(smallResult(81_920), false);
  for (const check of [
    () => assertUpload({ status: 400, text: "truncated multipart" }, 10),
    () => assertUpload({ status: 201, json: { rowCount: 9 }, headers: { "cache-control": "private, no-store" } }, 10),
    () => assertWorkflow({ status: 400, json: { error: { code: "invalid_request", message: "The request body must be a JSON object." } } }),
    () => assertScratchGrowth([]), () => assertScratchGrowth([4096, 4096]),
    () => assertNoTruncation("Request body exceeded 10MB for /api/tables. Only the first 10MB will be available unless configured. See proxyClientMaxBodySize."),
    () => assertSmallRefusal(smallResult(1), true),
    () => assertSmallRefusal(smallResult(81_921), false),
    () => assertSmallRefusal(smallResult(LARGE_SENDER), false),
  ]) expect(check).toThrow();
});

it.each([true, false])("reads the response while producing bytes and stops its sender (declared=%s)", async declared => {
  let written = 0, produced = 0;
  const fake = new EventEmitter() as EventEmitter & { destroyed: boolean; flushHeaders: () => void; write: (chunk: Buffer) => boolean; end: () => void; destroy: () => void };
  fake.destroyed = false;
  vi.spyOn(http, "request").mockImplementation(((_url: unknown, _options: unknown, callback: (response: EventEmitter) => void) => {
    const reply = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 413, headers: { "cache-control": "private, no-store" } });
      callback(response); fake.emit("response", response);
      response.emit("data", Buffer.from(JSON.stringify(tooLarge))); response.emit("end");
    };
    fake.flushHeaders = () => { if (declared) queueMicrotask(reply); };
    fake.write = chunk => { written += chunk.length; if (written > SMALL_LIMIT) queueMicrotask(reply); return true; };
    fake.end = () => { throw new Error("Sender finished before seeing the refusal"); };
    fake.destroy = () => { fake.destroyed = true; fake.emit("close"); };
    return fake;
  }) as typeof http.request);
  const result = await exchange("http://instance.test/api/published/token/widget-values", {
    headersOnly: declared, paceMs: 1,
    chunks: (function* () { while (produced < LARGE_SENDER) { produced += 4096; yield Buffer.alloc(4096); } })(),
  });
  assertSmallRefusal(result, declared);
  expect(result.bytesAtStatus).toBe(written);
  expect(produced).toBeLessThanOrEqual(written + 4096);
  expect(fake.destroyed).toBe(true);
});
