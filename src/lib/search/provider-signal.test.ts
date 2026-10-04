import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchPlaces } from "./provider";

const { takeSlot, openRemote, release } = vi.hoisted(() => ({ takeSlot: vi.fn(), openRemote: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/geocode/limiter", () => ({ takeSlot }));
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEZFIL_GEOCODER_URL", "https://fixture.test");
  takeSlot.mockResolvedValue(release);
  openRemote.mockImplementation(async () => ({ statusCode: 200, body: Readable.from([Buffer.from("[]")]) }));
});
afterEach(() => vi.unstubAllEnvs());

it("passes the caller through capacity and the entire exchange without changing the default timeout", async () => {
  const controller = new AbortController();
  // Reflect.apply keeps this red runnable against the prior one-argument seam.
  expect(await Reflect.apply(searchPlaces, null, ["harbour", controller.signal])).toEqual({ state: "ok", attribution: null, results: [] });
  expect(takeSlot).toHaveBeenCalledWith(expect.any(String), "interactive", controller.signal);
  expect(openRemote).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal, timeoutMs: 10_000 }));
  expect(release).toHaveBeenCalledOnce();
});

it("does not start an exchange when the capacity wait rejects", async () => {
  takeSlot.mockRejectedValue(new Error("abandoned"));
  await expect(Reflect.apply(searchPlaces, null, ["harbour", AbortSignal.abort()])).rejects.toThrow("abandoned");
  expect(openRemote).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});

it("retains a configured exchange deadline", async () => {
  vi.stubEnv("DEZFIL_GEOCODE_REQUEST_TIMEOUT_S", "30");
  await searchPlaces("harbour");
  expect(openRemote).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 30_000 }));
});

it.each(["headers", "body"])("releases capacity after cancellation during %s", async phase => {
  const controller = new AbortController();
  const body = new Readable({ read() {} });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  openRemote.mockImplementation((_url, { signal }) => {
    entered();
    if (phase === "headers") return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("abandoned")), { once: true });
    });
    signal?.addEventListener("abort", () => body.destroy(new Error("abandoned")), { once: true });
    return Promise.resolve({ statusCode: 200, body });
  });
  const pending = searchPlaces("harbour", controller.signal);
  await ready;
  expect(openRemote.mock.calls[0][1].signal).toBe(controller.signal);
  // Let the exchange attach its body consumer before delivering the abort.
  await Promise.resolve();
  expect(release).not.toHaveBeenCalled();
  controller.abort();
  expect(await pending).toEqual({ state: "failed", message: "The configured geocoding endpoint could not be reached." });
  expect(release).toHaveBeenCalledOnce();
});

it("retains answers and attribution and refuses a valid answer above one million bytes", async () => {
  const row = { name: "Harbour", display_name: "Harbour, Fixture coast", lat: "52.5", lon: "13.4", licence: "Fixture credit" };
  openRemote.mockResolvedValueOnce({ statusCode: 200, body: Readable.from([Buffer.from(JSON.stringify([row]))]) });
  expect(await searchPlaces("harbour")).toEqual({
    state: "ok", attribution: "Fixture credit",
    results: [{ name: "Harbour", context: "Fixture coast", lng: 13.4, lat: 52.5 }],
  });
  const oversized = JSON.stringify([{ ...row, padding: "a".repeat(1_000_001) }]);
  openRemote.mockResolvedValueOnce({ statusCode: 200, body: Readable.from([Buffer.from(oversized)]) });
  expect(await searchPlaces("harbour")).toEqual({
    state: "failed",
    message: "The configured geocoding endpoint answered in a shape this map search does not understand (Nominatim-compatible /search JSON v2 expected).",
  });
});
