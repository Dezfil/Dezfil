import { afterAll, expect, it, vi } from "vitest";
import puppeteer, { type HTTPRequest } from "puppeteer-core";

const { on, launch } = vi.hoisted(() => {
  const on = vi.fn();
  const newPage = vi.fn(async () => ({ on }));
  return { on, newPage, launch: vi.fn(async () => ({ newPage })) };
});

vi.mock("puppeteer-core", () => ({ default: { launch } }));
afterAll(() => vi.unstubAllEnvs());

it("substitutes only built-in styles with cross-origin-readable responses after admission", async () => {
  vi.stubEnv("DEZFIL_PICTURE_STYLE_FIXTURE", "1");
  vi.stubEnv("PORT", "3581");
  vi.stubEnv("DEZFIL_DATA_DIR", `${process.env.DEZFIL_DATA_DIR}/pictures-fixture`);
  await import("../../../scripts/pictures-browser-fixture-preload.mjs");
  const browser = await puppeteer.launch();
  await browser.newPage();
  const intercept = on.mock.calls.find(([event]) => event === "request")![1] as (request: HTTPRequest) => void;
  for (const [style, colour] of [["dark", "#1a2a3a"], ["positron", "#f0e6c8"], ["liberty", "#c8e0f0"]]) {
    const respond = vi.fn();
    const request = { url: () => `https://tiles.openfreemap.org/styles/${style}`, continue: vi.fn(), respond };
    intercept(request as unknown as HTTPRequest);
    expect(respond).not.toHaveBeenCalled();
    await request.continue();
    const response = respond.mock.calls[0][0];
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    // Without this header the render page's cross-origin style fetch is blocked.
    expect(new Headers(response.headers).get("Access-Control-Allow-Origin")).toBe("*");
    expect(JSON.parse(response.body)).toEqual({ version: 8, sources: {}, layers: [
      { id: "fixture-ground", type: "background", paint: { "background-color": colour } },
    ] });
  }
  for (const url of ["https://tiles.openfreemap.org/tiles/1/2/3", "https://other.test/styles/dark"]) {
    const resume = vi.fn(), respond = vi.fn();
    const request = { url: () => url, continue: resume, respond };
    intercept(request as unknown as HTTPRequest);
    expect(request.continue).toBe(resume);
    expect(respond).not.toHaveBeenCalled();
  }
});

it("redirects both appearances to the loopback tile fixture when measuring capacity", async () => {
  vi.stubEnv("DEZFIL_PICTURE_BASEMAP_URL", "http://127.0.0.1:3582/style.json");
  const browser = await puppeteer.launch();
  await browser.newPage();
  const intercept = on.mock.calls.at(-1)![1] as (request: HTTPRequest) => void;
  for (const [style, appearance] of [["positron", "light"], ["dark", "dark"]]) {
    const respond = vi.fn();
    const request = { url: () => `https://tiles.openfreemap.org/styles/${style}`, continue: vi.fn(), respond };
    intercept(request as unknown as HTTPRequest);
    expect(request.url()).toBe(`http://127.0.0.1:3582/${appearance}/style.json`);
    await request.continue();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ status: 302, headers: expect.objectContaining({
      Location: `http://127.0.0.1:3582/${appearance}/style.json`,
    }) }));
  }
});
