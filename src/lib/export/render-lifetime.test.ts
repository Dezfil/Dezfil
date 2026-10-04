import * as metadata from "@/lib/metadata/db";
import { Server } from "node:net";
import puppeteer from "puppeteer-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { EvaluationCancelled } from "@/lib/api/errors";
import { renderMapImage, renderQueueState } from "./render-image";
import * as relayModule from "./render-relay";
import { RelaySockets, deferred, socksRequest, until } from "./test-support/relay";
import type { ExportImageDefinition } from "./image-definition";

// A controlled browser lifecycle with real relay/target sockets. It makes no
// Chromium routing or pixels claim; those belong to the built-image probes.
vi.mock("puppeteer-core", () => ({ default: { launch: vi.fn() } }));
const realStart = relayModule.startRenderRelay;
const network = new RelaySockets();
const relays: relayModule.RenderRelay[] = [];
let db: ReturnType<typeof metadata.open>;
const definition: ExportImageDefinition = { viewport: { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 }, size: { width: 64, height: 64 }, mapScale: 1,
  legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light" };
const input = { mapId: "map", definition, baseUrl: "http://127.0.0.1:3216", credential: "fixture" };
const refusal = "The map reaches an address this instance's egress policy denies (private and internal ranges). The image was not produced.";
function pageFixture() {
  return { on: vi.fn(), setRequestInterception: vi.fn(), setViewport: vi.fn(), evaluateOnNewDocument: vi.fn(), goto: vi.fn(),
    waitForFunction: vi.fn(async () => {}), evaluate: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) };
}
function rawBrowser(page = pageFixture()) {
  const kill = vi.fn();
  return { newPage: async () => page, close: vi.fn(async () => {}), process: () => ({ kill }), kill, page };
}
beforeEach(() => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.mocked(puppeteer.launch).mockReset();
  vi.spyOn(relayModule, "startRenderRelay").mockImplementation(async options => {
    const relay = await realStart(options); relays.push(relay); return relay;
  });
});
afterEach(async () => { vi.restoreAllMocks(); for (const relay of relays.splice(0)) relay.close(); await network.close(); vi.unstubAllEnvs(); db.close(); });

it.each(["success", "refusal", "launch-failure", "crash", "timeout", "cancellation"])("ending %s leaves no listener or upstream before teardown and permits queued recovery", async ending => {
  vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "1");
  const target = await network.target(); await network.live(target);
  const denied = await network.target("::1"); await network.live(denied);
  const ready = deferred<void>(), finish = deferred<void>();
  const abort = new AbortController();
  let tunnel: Awaited<ReturnType<RelaySockets["client"]>> | undefined;
  let relayPort = 0;
  const browser = rawBrowser();
  browser.page.waitForFunction.mockImplementation(async () => {
    ready.resolve(); await finish.promise;
    if (ending === "refusal") {
      const client = await network.client(relayPort); client.socket.write(socksRequest("::1", denied.port));
      expect((await client.read(12))[3]).toBe(2);
    }
    if (ending === "crash") throw Error("Target closed");
  });
  vi.mocked(puppeteer.launch).mockImplementationOnce(async options => {
    relayPort = Number(options!.args!.find(flag => flag.startsWith("--proxy-server="))!.split(":").at(-1));
    tunnel = await network.client(relayPort); tunnel.socket.write(socksRequest("127.0.0.1", target.port));
    expect((await tunnel.read(12))[3]).toBe(0);
    if (ending === "launch-failure") { ready.resolve(); await finish.promise; throw Error("Browser did not launch"); }
    return browser as never;
  }).mockResolvedValue(rawBrowser() as never);
  const pending = renderMapImage(testAccountScope(), { ...input, signal: abort.signal, budgetMs: ending === "timeout" ? 700 : 10_000 })
    .then(value => ({ value }), error => ({ error }));
  await ready.promise;
  const next = renderMapImage(testAccountScope(), { ...input, budgetMs: 10_000 });
  expect(renderQueueState()).toEqual({ active: 1, waiting: 1 });
  if (ending === "cancellation") abort.abort();
  else if (ending !== "timeout") finish.resolve();
  const outcome = await pending;
  if (ending === "success") expect(outcome).toHaveProperty("value.png");
  else if (ending === "cancellation") expect(outcome).toHaveProperty("error", expect.any(EvaluationCancelled));
  else expect(outcome).toMatchObject({ error: { code: ending === "launch-failure" ? "render_unavailable" : ending === "timeout" ? "render_timeout" : "render_failed",
    ...(ending === "refusal" ? { status: 502, message: refusal } : {}) } });
  // These observations precede teardown and the 3 s browser close grace.
  await until(() => tunnel!.closed && target.active.size === 0, 2_900);
  await network.assertClosed(relayPort);
  expect(denied.contacts).toBe(0);
  await expect(next).resolves.toHaveProperty("png");
  expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  finish.resolve();
});

it("a forced bind failure opens no browser destination, answers the exact 502 and recovers", async () => {
  const occupied = await network.target(), destination = await network.target(); await network.live(destination);
  const listen = Server.prototype.listen;
  const bind = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    return Reflect.apply(listen, this, [occupied.port, "127.0.0.1", args.at(-1)]);
  });
  vi.mocked(puppeteer.launch).mockImplementation(async () => {
    const client = await network.client(destination.port); client.socket.write("unexpected browser destination");
    return rawBrowser() as never;
  });
  const outcome = await renderMapImage(testAccountScope(), input).then(value => ({ value }), error => ({ error }));
  expect(destination.contacts).toBe(0); expect(puppeteer.launch).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ error: { status: 502, code: "render_failed",
    message: "The image could not be rendered. Retry; if it persists, the instance's renderer needs attention." } });
  expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  bind.mockRestore(); vi.mocked(puppeteer.launch).mockResolvedValue(rawBrowser() as never);
  await expect(renderMapImage(testAccountScope(), input)).resolves.toHaveProperty("png");
});

it.each(["capture", "capture-error"])("a real refusal during %s beats a held sibling tunnel", async phase => {
  const target = await network.target(), denied = await network.target("::1"); await network.live(denied);
  const browser = rawBrowser(); let port = 0;
  browser.page.screenshot.mockImplementation(async () => {
    const refused = await network.client(port); refused.socket.write(socksRequest("::1", denied.port));
    expect((await refused.read(12))[3]).toBe(2); expect(target.active.size).toBe(1);
    if (phase === "capture-error") throw Error("Capture lost its target");
    return new Uint8Array([137, 80, 78, 71]);
  });
  vi.mocked(puppeteer.launch).mockImplementation(async options => {
    port = Number(options!.args!.find(flag => flag.startsWith("--proxy-server="))!.split(":").at(-1));
    const held = await network.client(port); held.socket.write(socksRequest("127.0.0.1", target.port)); await held.read(12);
    return browser as never;
  });
  await expect(renderMapImage(testAccountScope(), input)).rejects.toMatchObject({ status: 502, code: "render_failed", message: refusal });
  expect(denied.contacts).toBe(0); await until(() => target.active.size === 0); await network.assertClosed(port);
});

it.each(["timeout", "cancellation"])("%s during launch closes the relay and kills a late browser", async ending => {
  const abort = new AbortController(), late = deferred<ReturnType<typeof rawBrowser>>(), entered = deferred<void>();
  let port = 0;
  vi.mocked(puppeteer.launch).mockImplementation(async options => {
    port = Number(options!.args!.find(flag => flag.startsWith("--proxy-server="))!.split(":").at(-1));
    entered.resolve(); return await late.promise as never;
  });
  const pending = renderMapImage(testAccountScope(), { ...input, budgetMs: ending === "timeout" ? 200 : 10_000, signal: abort.signal })
    .catch(error => error);
  await entered.promise; if (ending === "cancellation") abort.abort();
  const error = await pending;
  if (ending === "timeout") expect(error).toMatchObject({ code: "render_timeout" });
  else expect(error).toBeInstanceOf(EvaluationCancelled);
  await network.assertClosed(port);
  const browser = rawBrowser(); late.resolve(browser); await until(() => browser.kill.mock.calls.length === 1);
  expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
});

it("closing one concurrent render leaves the other's tunnel usable", async () => {
  vi.stubEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", "2");
  const target = await network.target(), hold = deferred<void>();
  const clients: Awaited<ReturnType<RelaySockets["client"]>>[] = [];
  const entered = deferred<void>();
  vi.mocked(puppeteer.launch).mockImplementation(async options => {
    const port = Number(options!.args!.find(flag => flag.startsWith("--proxy-server="))!.split(":").at(-1));
    const client = await network.client(port); client.socket.write(socksRequest("127.0.0.1", target.port)); await client.read(12);
    const index = clients.push(client); const browser = rawBrowser();
    browser.page.waitForFunction.mockImplementation(async () => { if (index === 2) entered.resolve(); await hold.promise; });
    return browser as never;
  });
  const abort = new AbortController();
  const first = renderMapImage(testAccountScope(), { ...input, signal: abort.signal }).catch(error => error);
  await until(() => clients.length === 1);
  const second = renderMapImage(testAccountScope(), input); await entered.promise;
  abort.abort(); expect(await first).toBeInstanceOf(EvaluationCancelled);
  await until(() => clients[0].closed); clients[1].socket.write("usable");
  expect((await clients[1].read(18)).subarray(12).toString()).toBe("usable");
  hold.resolve(); await expect(second).resolves.toHaveProperty("png");
});

it("waits for an abandoned connection verdict after capture instead of returning an image", async () => {
  const denied = await network.target("::1"); await network.live(denied);
  const answer = deferred<string[]>(), resolving = deferred<void>();
  vi.mocked(relayModule.startRenderRelay).mockImplementation(async options => {
    const relay = await realStart({ ...options, requestBoundMs: 40, resolve: async () => { resolving.resolve(); return answer.promise; } });
    relays.push(relay); return relay;
  });
  const browser = rawBrowser(); let port = 0;
  browser.page.screenshot.mockImplementation(async () => {
    const abandoned = await network.client(port); abandoned.socket.write(socksRequest("held.test", denied.port));
    await resolving.promise; abandoned.socket.destroy(); await until(() => abandoned.closed);
    // Resolve after the relay has also abandoned the unfinished connection.
    setTimeout(() => answer.resolve(["::1"]), 100);
    return new Uint8Array([137, 80, 78, 71]);
  });
  vi.mocked(puppeteer.launch).mockImplementation(async options => {
    port = Number(options!.args!.find(flag => flag.startsWith("--proxy-server="))!.split(":").at(-1));
    return browser as never;
  });
  await expect(renderMapImage(testAccountScope(), input)).rejects.toMatchObject({ status: 502, code: "render_failed", message: refusal });
  expect(denied.contacts).toBe(0); await network.assertClosed(port);
});

it("closes the relay independently of an uncooperative browser close", async () => {
  const target = await network.target(); let port = 0;
  const browser = rawBrowser(); browser.close.mockImplementation(() => new Promise(() => {}));
  vi.mocked(puppeteer.launch).mockImplementation(async options => {
    port = Number(options!.args!.find(flag => flag.startsWith("--proxy-server="))!.split(":").at(-1));
    const held = await network.client(port); held.socket.write(socksRequest("127.0.0.1", target.port)); await held.read(12);
    return browser as never;
  });
  await expect(renderMapImage(testAccountScope(), input)).resolves.toHaveProperty("png");
  await until(() => target.active.size === 0, 2_900); await network.assertClosed(port);
  await until(() => browser.kill.mock.calls.length === 1, 3_500);
});
