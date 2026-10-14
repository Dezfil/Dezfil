import * as metadata from "@/lib/metadata/db";
import puppeteer from "puppeteer-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { renderMapImage, renderQueueState } from "./render-image";
import { startRenderRelay, type RenderRelay } from "./render-relay";
import type { ExportImageDefinition } from "./image-definition";
import { puppeteerDriver } from "./render-driver";
import { settleRenderTiles } from "./render-settle";

vi.mock("puppeteer-core", () => ({ default: { launch: vi.fn() } }));
vi.mock("./render-relay", () => ({ startRenderRelay: vi.fn() }));
vi.mock("./render-guard", () => ({ admitRenderRequest: vi.fn(async () => "allow") }));
let db: ReturnType<typeof metadata.open>;
const definition: ExportImageDefinition = { viewport: { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 }, size: { width: 64, height: 64 }, mapScale: 1,
  legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light" };
const input = { mapId: "map", definition, baseUrl: "http://127.0.0.1:3216", credential: "fixture" };
const refusal = "The map reaches an address this instance's egress policy denies (private and internal ranges). The image was not produced.";
let denied: boolean;
const closeRelay = vi.fn();
const abandonRelay = vi.fn<RenderRelay["abandon"]>();
const page = {
  on: vi.fn(), setRequestInterception: vi.fn(), setViewport: vi.fn(), evaluateOnNewDocument: vi.fn(), goto: vi.fn(),
  waitForFunction: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), setOfflineMode: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks(); denied = false;
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  vi.mocked(startRenderRelay).mockResolvedValue({ port: 43127, get refused() { return denied; }, close: closeRelay, abandon: abandonRelay, settleAdmissions: async () => {} });
  page.setOfflineMode.mockResolvedValue(undefined);
  page.evaluate.mockResolvedValue(undefined);
  page.screenshot.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  vi.mocked(puppeteer.launch).mockResolvedValue({ newPage: async () => page, close: async () => {}, process: () => null } as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

it("starts the relay before browser launch with an exact scheme/host/port exception", async () => {
  await renderMapImage(testAccountScope(), input);
  expect(startRenderRelay).toHaveBeenCalledOnce();
  expect(vi.mocked(startRenderRelay).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(puppeteer.launch).mock.invocationCallOrder[0]);
  const args = vi.mocked(puppeteer.launch).mock.calls[0][0]!.args!;
  expect(args).toContain("--proxy-server=socks5://127.0.0.1:43127");
  expect(args).toContain("--proxy-bypass-list=<-loopback>;http://127.0.0.1:3216");
  for (const flag of ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable", "--disable-background-networking"]) expect(args).toContain(flag);
  expect(args.some(flag => /direct|pac-url|ignore-certificate/.test(flag))).toBe(false);
  expect(closeRelay).toHaveBeenCalled();
});
it("a relay startup failure answers the shipped generic 502 without launching, then recovers", async () => {
  vi.mocked(startRenderRelay).mockRejectedValueOnce(Error("EADDRINUSE"));
  await expect(renderMapImage(testAccountScope(), input)).rejects.toMatchObject({ status: 502, code: "render_failed",
    message: "The image could not be rendered. Retry; if it persists, the instance's renderer needs attention." });
  expect(puppeteer.launch).not.toHaveBeenCalled();
  expect(renderQueueState()).toEqual({ active: 0, waiting: 0 });
  await expect(renderMapImage(testAccountScope(), input)).resolves.toHaveProperty("png");
});
it.each(["readiness", "capture", "capture-error", "page-failure"])("a connection refusal during %s wins over the image or generic error", async mode => {
  if (mode === "readiness") page.waitForFunction.mockImplementation(async () => { denied = true; });
  if (mode === "capture" || mode === "capture-error") page.screenshot.mockImplementation(async () => { denied = true; if (mode === "capture-error") throw Error("Target closed"); return new Uint8Array([137]); });
  if (mode === "page-failure") page.evaluate.mockImplementation(async () => { denied = true; return "An unrelated page failure"; });
  await expect(renderMapImage(testAccountScope(), input)).rejects.toMatchObject({ status: 502, code: "render_failed", message: refusal });
});
it("without a policy refusal a failed style can still produce the page's dead-style image", async () => {
  await expect(renderMapImage(testAccountScope(), input)).resolves.toHaveProperty("png");
});
it("waits for a connection verdict that outlives capture", async () => {
  vi.mocked(startRenderRelay).mockResolvedValue({ port: 43127, get refused() { return denied; }, close: closeRelay, abandon: abandonRelay,
    settleAdmissions: async () => { denied = true; } } as Awaited<ReturnType<typeof startRenderRelay>>);
  await expect(renderMapImage(testAccountScope(), input)).rejects.toMatchObject({ status: 502, code: "render_failed", message: refusal });
});

it.each([
  { cuts: 1, hostname: "tiles.example.org", host: "tiles.example.org" },
  { cuts: 2, hostname: "tiles.example.org", host: "tiles.example.org" },
  { cuts: 1, hostname: "[2001:db8::1]", host: "2001:db8::1" },
])("cuts $hostname $cuts times through the relay before the page flip and stop", async ({ cuts, hostname, host }) => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  page.goto.mockImplementation(async () => {
    const onRequest = page.on.mock.calls.find(([event]) => event === "request")![1];
    onRequest({ id: "tile", url: () => `https://${hostname}/held.pbf`, headers: () => ({}), continue: vi.fn(), abort: vi.fn() });
  });
  page.waitForFunction.mockImplementation(async () => { await vi.advanceTimersByTimeAsync(cuts * 20_000 + 5_000); });
  const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
  const result = await renderMapImage(testAccountScope(), { ...input, credential });
  expect(result.abandoned).toEqual(Array(cuts).fill(host));
  expect(abandonRelay.mock.calls).toEqual(Array.from({ length: cuts }, () => [[host]]));
  for (let i = 0; i < cuts; i++) {
    expect(abandonRelay.mock.invocationCallOrder[i]).toBeLessThan(page.setOfflineMode.mock.invocationCallOrder[i * 2]);
  }
  expect(page.setOfflineMode.mock.calls).toEqual(Array.from({ length: cuts }, () => [[true], [false]]).flat());
  const stop = vi.fn();
  vi.stubGlobal("window", { stop });
  const stops = page.evaluate.mock.calls.filter(([fn]) => fn !== settleRenderTiles);
  try { for (let i = 0; i < cuts; i++) stops[i][0](); } finally { vi.unstubAllGlobals(); }
  expect(stop).toHaveBeenCalledTimes(cuts);
});

it("counts every cut request but refuses only a host whose request outlived the bound", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const request = (host: string) => {
    const onRequest = page.on.mock.calls.find(([event]) => event === "request")![1];
    onRequest({ id: host, url: () => `https://${host}/tile`, headers: () => ({}), continue: vi.fn(), abort: vi.fn() });
  };
  page.goto.mockImplementation(async () => { request("stalled.test"); });
  page.waitForFunction.mockImplementation(async () => {
    await vi.advanceTimersByTimeAsync(18_000);
    request("young.test");
    await vi.advanceTimersByTimeAsync(7_000);
  });
  const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
  const result = await renderMapImage(testAccountScope(), { ...input, credential });
  expect(result.abandoned).toEqual(["stalled.test", "young.test"]);
  expect(abandonRelay.mock.calls).toEqual([[["stalled.test"]]]);
});

it("tells the page to settle tiles at the first cut, never before or again", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const settle = vi.fn();
  const dataset = Object.defineProperty({}, "exportTilesSettled", { set: settle });
  vi.stubGlobal("document", { documentElement: { dataset }, querySelector: () => null });
  vi.stubGlobal("window", { stop: vi.fn() });
  page.evaluate.mockImplementation(async fn => fn());
  page.goto.mockImplementation(async () => {
    const onRequest = page.on.mock.calls.find(([event]) => event === "request")![1];
    onRequest({ id: "tile", url: () => "https://tiles.example.org/held.pbf", headers: () => ({}), continue: vi.fn(), abort: vi.fn() });
  });
  page.waitForFunction.mockImplementation(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
    expect(abandonRelay).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(abandonRelay).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith("true");
    await vi.advanceTimersByTimeAsync(20_500);
    expect(abandonRelay).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledOnce();
  });
  try {
    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const deadline = Date.now() + 90_000;
    const browser = await (await puppeteerDriver()).launch("unused", [], { appOrigin: input.baseUrl, deadline, requestBoundMs: 20_000 });
    try {
      await browser.render({ url: input.baseUrl + "/render/map", credential, definition, width: 64, height: 64, deadline, requestBoundMs: 20_000 });
    } finally { await browser.close(); }
  } finally { vi.unstubAllGlobals(); }
});
