// Active-native-transfer evidence/0093. The existing recovery journey proves
// the original download bytes, but its tiny fixture can finish before status
// uncertainty releases the ticket. This arm keeps the real CSV attachment in
// flight with a backpressured loopback proxy until after all three bounded
// status observations.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  request as nodeRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  expect,
  test,
  type APIRequestContext,
  type Download,
  type Page,
  type Route,
} from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import {
  addLayer,
  createMap,
  routeHouse,
  seedCsv,
  trackConsole,
} from "./support";

const runId = Date.now().toString(36);
const tableName = `active_stream_${runId}`;
const layerName = "Active stream points";
const ROW_COUNT = 2_560;
const PAYLOAD_WIDTH = 1_024;
const FIRST_SENTINEL = "FIRST_ACTIVE_NATIVE_STREAM";
const LAST_SENTINEL = "LAST_ACTIVE_NATIVE_STREAM";
const MIDDLE_SENTINEL = "middle";
const STATUS_OBSERVATION_TIMEOUT_MS = 5_000;
const STATUS_OBSERVATION_COUNT = 3;
const STATUS_POLL_INTERVAL_MS = 250;
const STATUS_CONTROL_BUDGET_MS =
  STATUS_OBSERVATION_TIMEOUT_MS * STATUS_OBSERVATION_COUNT +
  STATUS_POLL_INTERVAL_MS * (STATUS_OBSERVATION_COUNT - 1);
const BROWSER_RECOVERY_RENDER_MARGIN_MS = 3_000;
const PAYLOAD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const PROXY_PATH_PREFIX = "/__active-native-stream__";
const PROXY_FIRST_CHUNK_BYTES = 16 * 1_024;

interface HeldStatusObservations {
  arrivals: number[];
  tickets: string[];
  release: () => void;
  released: Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface AttachmentHeaders {
  contentType: string | null;
  contentLength: string | null;
  contentDisposition: string | null;
  cacheControl: string | null;
}

interface ProxyStart {
  targetUrl: string;
  statusCode: number;
  upstreamHeaders: AttachmentHeaders;
  forwardedHeaders: AttachmentHeaders;
}

interface SlowDownloadProxy {
  started: Promise<ProxyStart>;
  firstChunkForwarded: Promise<void>;
  finished: Promise<void>;
  proxyUrl: (originalUrl: URL) => URL;
  snapshot: () => {
    requests: number;
    bytesForwarded: number;
    held: boolean;
    browserClosed: boolean;
    upstreamComplete: boolean;
    upstreamReadableEnded: boolean;
    active: boolean;
  };
  lift: () => void;
  close: () => Promise<void>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

function attachmentHeaders(headers: IncomingHttpHeaders): AttachmentHeaders {
  return {
    contentType: header(headers, "content-type"),
    contentLength: header(headers, "content-length"),
    contentDisposition: header(headers, "content-disposition"),
    cacheControl: header(headers, "cache-control"),
  };
}

function forwardedAttachmentHeaders(
  headers: AttachmentHeaders,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  if (headers.contentType !== null) {
    forwarded["content-type"] = headers.contentType;
  }
  if (headers.contentLength !== null) {
    forwarded["content-length"] = headers.contentLength;
  }
  if (headers.contentDisposition !== null) {
    forwarded["content-disposition"] = headers.contentDisposition;
  }
  if (headers.cacheControl !== null) {
    forwarded["cache-control"] = headers.cacheControl;
  }
  return forwarded;
}

async function writeChunk(
  response: ServerResponse,
  chunk: Buffer,
): Promise<void> {
  if (response.destroyed) throw new Error("browser download connection closed");
  if (!response.write(chunk)) await once(response, "drain");
}

async function startSlowDownloadProxy(
  appOrigin: string,
): Promise<SlowDownloadProxy> {
  const upstreamOrigin = new URL(appOrigin);
  if (upstreamOrigin.protocol !== "http:") {
    throw new Error(
      `active-stream proxy requires the app's HTTP loopback origin, got ${appOrigin}`,
    );
  }

  const started = deferred<ProxyStart>();
  const firstChunkForwarded = deferred<void>();
  const finished = deferred<void>();
  const lifted = deferred<void>();
  // Every deferred rejection is observed immediately; the test still awaits
  // the original promise at the assertion that owns it.
  void started.promise.catch(() => undefined);
  void firstChunkForwarded.promise.catch(() => undefined);
  void finished.promise.catch(() => undefined);

  let requests = 0;
  let bytesForwarded = 0;
  let holdLifted = false;
  let browserClosed = false;
  let proxyFinished = false;
  let upstreamRequest: ReturnType<typeof nodeRequest> | null = null;
  let upstreamResponse: IncomingMessage | null = null;
  let browserResponse: ServerResponse | null = null;

  const fail = (error: unknown) => {
    started.reject(error);
    firstChunkForwarded.reject(error);
    finished.reject(error);
  };

  const server = createServer((incoming, outgoing) => {
    outgoing.on("error", () => undefined);
    void (async () => {
      requests += 1;
      if (requests !== 1 || incoming.method !== "GET" || !incoming.url) {
        outgoing.writeHead(409).end("unexpected proxy request");
        throw new Error("active-stream proxy received an unexpected request");
      }

      const incomingUrl = new URL(incoming.url, "http://127.0.0.1");
      if (!incomingUrl.pathname.startsWith(PROXY_PATH_PREFIX)) {
        outgoing.writeHead(404).end("unknown proxy path");
        throw new Error("active-stream proxy received an unknown path");
      }
      const originalPath = incomingUrl.pathname.slice(PROXY_PATH_PREFIX.length);
      const target = new URL(`${originalPath}${incomingUrl.search}`, appOrigin);
      if (target.origin !== upstreamOrigin.origin) {
        outgoing.writeHead(400).end("invalid proxy target");
        throw new Error("active-stream proxy target escaped the app origin");
      }

      browserResponse = outgoing;
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const headers: Record<string, string> = {
          accept: incoming.headers.accept ?? "*/*",
          "accept-encoding": "identity",
        };
        if (incoming.headers.cookie) headers.cookie = incoming.headers.cookie;
        upstreamRequest = nodeRequest(
          target,
          { method: "GET", headers },
          resolve,
        );
        upstreamRequest.once("error", reject);
        upstreamRequest.end();
      });
      upstreamResponse = upstream;

      const upstreamAttachmentHeaders = attachmentHeaders(upstream.headers);
      const responseHeaders = forwardedAttachmentHeaders(
        upstreamAttachmentHeaders,
      );
      outgoing.writeHead(upstream.statusCode ?? 502, responseHeaders);
      outgoing.flushHeaders();
      started.resolve({
        targetUrl: target.toString(),
        statusCode: upstream.statusCode ?? 502,
        upstreamHeaders: upstreamAttachmentHeaders,
        forwardedHeaders: attachmentHeaders(responseHeaders),
      });

      const abortUpstream = () => {
        if (outgoing.writableFinished) return;
        browserClosed = true;
        upstreamRequest?.destroy();
        upstream.destroy();
      };
      incoming.once("aborted", abortUpstream);
      outgoing.once("close", abortUpstream);

      let first = true;
      for await (const value of upstream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (first) {
          first = false;
          const split = Math.min(PROXY_FIRST_CHUNK_BYTES, chunk.byteLength);
          await writeChunk(outgoing, chunk.subarray(0, split));
          bytesForwarded += split;
          firstChunkForwarded.resolve();
          // Backpressure stops here with only one bounded upstream chunk in
          // memory. The app's real response remains open until the test lifts.
          await lifted.promise;
          if (split < chunk.byteLength) {
            await writeChunk(outgoing, chunk.subarray(split));
            bytesForwarded += chunk.byteLength - split;
          }
          continue;
        }
        await writeChunk(outgoing, chunk);
        bytesForwarded += chunk.byteLength;
      }
      if (first) {
        throw new Error("active-stream proxy received an empty attachment");
      }
      outgoing.end();
      if (!outgoing.writableFinished) await once(outgoing, "finish");
      proxyFinished = true;
      finished.resolve();
    })().catch((error: unknown) => {
      fail(error);
      if (!outgoing.headersSent) outgoing.writeHead(502);
      if (!outgoing.writableEnded) outgoing.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const proxyOrigin = `http://127.0.0.1:${address.port}`;

  return {
    started: started.promise,
    firstChunkForwarded: firstChunkForwarded.promise,
    finished: finished.promise,
    proxyUrl: (originalUrl) => {
      if (originalUrl.protocol !== upstreamOrigin.protocol) {
        throw new Error("proxy rewrite must keep the download protocol");
      }
      const proxied = new URL(
        `${PROXY_PATH_PREFIX}${originalUrl.pathname}`,
        proxyOrigin,
      );
      proxied.search = originalUrl.search;
      return proxied;
    },
    snapshot: () => ({
      requests,
      bytesForwarded,
      held: !holdLifted,
      browserClosed,
      upstreamComplete: upstreamResponse?.complete ?? false,
      upstreamReadableEnded: upstreamResponse?.readableEnded ?? false,
      active:
        upstreamResponse !== null &&
        browserResponse !== null &&
        !upstreamResponse.complete &&
        !upstreamResponse.readableEnded &&
        !upstreamResponse.destroyed &&
        !browserResponse.writableEnded &&
        !browserClosed &&
        !proxyFinished,
    }),
    lift: () => {
      if (holdLifted) return;
      holdLifted = true;
      lifted.resolve();
    },
    close: async () => {
      if (!holdLifted) {
        holdLifted = true;
        lifted.resolve();
      }
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
      browserResponse?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function sentinelFor(row: number): string {
  if (row === 0) return FIRST_SENTINEL;
  if (row === ROW_COUNT - 1) return LAST_SENTINEL;
  return MIDDLE_SENTINEL;
}

function payloadFor(row: number): string {
  let state = Math.imul(row + 1, 0x9e3779b1) >>> 0;
  const payload = new Array<string>(PAYLOAD_WIDTH);
  for (let column = 0; column < PAYLOAD_WIDTH; column += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[column] = PAYLOAD_ALPHABET[state & 63];
  }
  return payload.join("");
}

function csvFixture(): { source: string; expected: Buffer } {
  const source = ["row_id,sentinel,payload"];
  const expected = ["row_id,sentinel,payload,geometry"];
  for (let row = 0; row < ROW_COUNT; row += 1) {
    const data = `${row},${sentinelFor(row)},${payloadFor(row)}`;
    source.push(data);
    expected.push(`${data},POINT (0 0)`);
  }
  return {
    source: `${source.join("\n")}\n`,
    expected: Buffer.from(`${expected.join("\n")}\n`),
  };
}

function layerSql(): string {
  return `SELECT row_id, sentinel, payload,
                 ST_Point(0, 0) AS geometry
          FROM "${tableName}"
          ORDER BY row_id`;
}

function activeNote(page: Page, layerId: string) {
  return page.locator(`[data-layer-download-active="${layerId}:csv"]`);
}

function failureNote(page: Page, layerId: string) {
  return page.locator(`[data-layer-download-failed="${layerId}:csv"]`);
}

function downloadFrame(page: Page, mapId: string, layerId: string) {
  return page.locator(
    `iframe[data-layer-download-frame="${mapId}:${layerId}:csv"]`,
  );
}

async function openHeaderCsv(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Export" });
  await menu.getByRole("menuitem", { name: /Data/ }).click();
  const row = menu.locator("[class*=layerRow]", { hasText: layerName });
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole("menuitem", { name: "CSV", exact: true }).click();
}

function isLayerDownloadUrl(
  value: string,
  layerId: string,
  marker: "__ui_download" | "__ui_status",
): boolean {
  const url = new URL(value);
  return (
    url.pathname === `/api/layers/${layerId}/export/csv` &&
    url.searchParams.has(marker)
  );
}

function requireCapturedDownloadUrl(value: URL | null): URL {
  if (!value) {
    throw new Error("native download route was not captured before rewrite");
  }
  return value;
}

async function ticketStatus(
  request: APIRequestContext,
  downloadUrl: URL,
): Promise<{ httpStatus: number; status: string | null }> {
  const ticket = downloadUrl.searchParams.get("__ui_download");
  if (!ticket) throw new Error("native download URL has no private ticket");
  const statusUrl = new URL(downloadUrl);
  statusUrl.search = "";
  statusUrl.searchParams.set("__ui_status", ticket);
  const response = await request.get(statusUrl.toString());
  const body = response.ok()
    ? ((await response.json()) as { status?: unknown })
    : null;
  return {
    httpStatus: response.status(),
    status: typeof body?.status === "string" ? body.status : null,
  };
}

async function expectStillPending<T>(promise: Promise<T>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), 250);
    }),
  ]);
  if (timer) clearTimeout(timer);
  expect(state).toBe("pending");
}

function holdStatusObservations(): HeldStatusObservations {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrivals: [], tickets: [], release, released };
}

test("status recovery releases the UI while the same native stream stays alive", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(120_000);

  const fixture = csvFixture();
  const expected = fixture.expected;
  expect(expected.byteLength).toBeGreaterThan(2 * 1_024 * 1_024);
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  const consoleErrors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });

  let mapId: string | null = null;
  let layerId: string | null = null;
  let download: Download | null = null;
  let downloadCompleted = false;
  let proxy: SlowDownloadProxy | null = null;
  let originalDownloadUrl: URL | null = null;
  const heldStatus = holdStatusObservations();
  const layerRoute = async (route: Route) => {
    if (
      layerId &&
      isLayerDownloadUrl(route.request().url(), layerId, "__ui_download")
    ) {
      if (!proxy) throw new Error("active-stream proxy is not ready");
      if (originalDownloadUrl) {
        throw new Error("active-stream proxy received a second download");
      }
      originalDownloadUrl = new URL(route.request().url());
      await route.continue({
        url: proxy.proxyUrl(originalDownloadUrl).toString(),
      });
      return;
    }
    if (
      layerId &&
      isLayerDownloadUrl(route.request().url(), layerId, "__ui_status")
    ) {
      const url = new URL(route.request().url());
      const isRelease = url.searchParams.get("__ui_release") === "1";
      if (!isRelease && heldStatus.arrivals.length < STATUS_OBSERVATION_COUNT) {
        heldStatus.arrivals.push(Date.now());
        heldStatus.tickets.push(url.searchParams.get("__ui_status") ?? "");
        await heldStatus.released;
        // Product timeouts have already aborted these fetches. Continuing is
        // only fixture teardown and is deliberately too late to cause recovery.
        await route.continue().catch(() => undefined);
        return;
      }
    }
    await route.continue();
  };

  try {
    await page.goto("/maps");
    await seedCsv(page, tableName, fixture.source);
    mapId = await createMap(page, `Active native stream ${runId}`);
    layerId = await addLayer(page, mapId, layerName, layerSql());
    await page.goto(`/maps/${mapId}`);
    await expect(
      page.getByRole("button", { name: new RegExp(`^${layerName}`) }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const builderUrl = page.url();
    proxy = await startSlowDownloadProxy(new URL(builderUrl).origin);
    await page.route("**/api/layers/**", layerRoute);

    const downloadStarted = page.waitForEvent("download", { timeout: 60_000 });
    void downloadStarted.catch(() => undefined);
    const releaseAnswered = page.waitForResponse(
      (response) => {
        if (!layerId) return false;
        const url = new URL(response.url());
        return (
          isLayerDownloadUrl(response.url(), layerId, "__ui_status") &&
          url.searchParams.get("__ui_release") === "1"
        );
      },
      { timeout: STATUS_CONTROL_BUDGET_MS + 15_000 },
    );
    void releaseAnswered.catch(() => undefined);

    await openHeaderCsv(page);
    download = await downloadStarted;
    const proxyStart = await proxy.started;
    await proxy.firstChunkForwarded;
    expect(download.suggestedFilename()).toBe(`${layerName}.csv`);
    expect(download.url()).not.toMatch(/^blob:/);
    const nativeUrl = requireCapturedDownloadUrl(originalDownloadUrl);
    const nativeTicket = nativeUrl.searchParams.get("__ui_download");
    expect(nativeTicket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nativeUrl.pathname).toBe(`/api/layers/${layerId}/export/csv`);
    expect(new URL(download.url()).searchParams.get("__ui_download")).toBe(
      nativeTicket,
    );
    expect(proxyStart).toEqual({
      targetUrl: nativeUrl.toString(),
      statusCode: 200,
      upstreamHeaders: {
        contentType: "text/csv; charset=utf-8",
        contentLength: String(expected.byteLength),
        contentDisposition: `attachment; filename="${layerName}.csv"`,
        cacheControl: "no-store",
      },
      forwardedHeaders: {
        contentType: "text/csv; charset=utf-8",
        contentLength: String(expected.byteLength),
        contentDisposition: `attachment; filename="${layerName}.csv"`,
        cacheControl: "no-store",
      },
    });

    const sameDownloadPath = download.path().then((path) => {
      downloadCompleted = true;
      return path;
    });
    await expectStillPending(sameDownloadPath);
    await expect(activeNote(page, layerId)).toBeVisible();
    await expect(downloadFrame(page, mapId, layerId)).toHaveCount(1);
    await expect
      .poll(() => heldStatus.arrivals.length, {
        timeout: STATUS_CONTROL_BUDGET_MS,
      })
      .toBe(STATUS_OBSERVATION_COUNT);

    const note = failureNote(page, layerId);
    await expect(note).toBeVisible({
      timeout:
        STATUS_OBSERVATION_TIMEOUT_MS + BROWSER_RECOVERY_RENDER_MARGIN_MS,
    });
    await expect(note).toContainText(
      "The download could not be confirmed. Check your Downloads, then retry if needed.",
    );
    expect(heldStatus.arrivals).toHaveLength(STATUS_OBSERVATION_COUNT);
    expect(heldStatus.tickets).toEqual(
      Array(STATUS_OBSERVATION_COUNT).fill(nativeTicket),
    );
    expect(heldStatus.arrivals[1] - heldStatus.arrivals[0]).toBeGreaterThanOrEqual(
      STATUS_OBSERVATION_TIMEOUT_MS,
    );
    expect(heldStatus.arrivals[2] - heldStatus.arrivals[1]).toBeGreaterThanOrEqual(
      STATUS_OBSERVATION_TIMEOUT_MS,
    );
    expect(page.url()).toBe(builderUrl);
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expect(activeNote(page, layerId)).toHaveCount(0);
    await expect(downloadFrame(page, mapId, layerId)).toHaveCount(0);

    const releaseResponse = await releaseAnswered;
    expect(releaseResponse.status()).toBe(204);
    expect(releaseResponse.headers()["cache-control"]).toBe("no-store");
    expect(new URL(releaseResponse.url()).searchParams.get("__ui_status")).toBe(
      nativeTicket,
    );

    // Recovery detached the frame and sent release, but neither operation may
    // abort a browser-owned attachment. The server must still see this exact
    // ticket as streaming, and Playwright's path must still be unresolved.
    await expect(ticketStatus(request, nativeUrl)).resolves.toEqual({
      httpStatus: 200,
      status: "streaming",
    });
    expect(proxy.snapshot()).toMatchObject({
      requests: 1,
      held: true,
      browserClosed: false,
      upstreamComplete: false,
      upstreamReadableEnded: false,
      active: true,
    });
    expect(proxy.snapshot().bytesForwarded).toBeGreaterThan(0);
    expect(proxy.snapshot().bytesForwarded).toBeLessThanOrEqual(
      PROXY_FIRST_CHUNK_BYTES,
    );
    await expectStillPending(sameDownloadPath);

    proxy.lift();

    const path = await sameDownloadPath;
    await proxy.finished;
    const bytes = readFileSync(path);
    expect(bytes.byteLength).toBe(expected.byteLength);
    expect(bytes.includes(Buffer.from(FIRST_SENTINEL))).toBe(true);
    expect(bytes.includes(Buffer.from(LAST_SENTINEL))).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHash);
    expect(proxy.snapshot()).toMatchObject({
      requests: 1,
      bytesForwarded: expected.byteLength,
      held: false,
      browserClosed: false,
      active: false,
    });
    await expect(download.failure()).resolves.toBeNull();
    await expect
      .poll(async () => (await ticketStatus(request, nativeUrl)).status)
      .toBe("complete");

    heldStatus.release();
    await page.unrouteAll({ behavior: "wait" });
    const unexpected = consoleErrors.filter(
      (entry) => !isAllowedConsoleError(entry.text, entry.url),
    );
    expect(unexpected).toEqual([]);
  } finally {
    heldStatus.release();
    proxy?.lift();
    if (download && !downloadCompleted) {
      await download.cancel().catch(() => undefined);
    }
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    if (mapId) {
      await request.delete(`/api/maps/${mapId}`).catch(() => undefined);
    }
    await request.delete(`/api/tables/${tableName}`).catch(() => undefined);
  }
});
