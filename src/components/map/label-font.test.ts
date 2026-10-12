import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The label face and when labels may draw, against a stand-in document whose
 * font loads this test settles by hand. Each case imports the module afresh:
 * readiness is the page's, held once per document.
 */

type Deferred = { promise: Promise<unknown>; resolve: () => void; reject: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res([]);
    reject = () => rej(new Error("network"));
  });
  return { promise, resolve, reject };
}

let asked: string[];
let pending: Deferred[];
let declared: string;

beforeEach(() => {
  vi.resetModules();
  asked = [];
  pending = [];
  declared = '"Inter", "Inter Fallback"';
  vi.stubGlobal("document", {
    documentElement: {},
    fonts: {
      load: (font: string) => {
        asked.push(font);
        const d = deferred();
        pending.push(d);
        return d.promise;
      },
    },
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => (name === "--font-inter" ? ` ${declared}` : ""),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fresh = () => import("./label-font");
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the face labels draw in", () => {
  it("is the document's interface face, as the root declares it", async () => {
    const font = await fresh();
    expect(font.labelFontFamily()).toBe('"Inter", "Inter Fallback"');
  });

  it("falls back to the face by name where the document declares none", async () => {
    declared = "";
    const font = await fresh();
    expect(font.labelFontFamily()).toBe(font.LABEL_FONT_FALLBACK);
  });
});

describe("labels wait for their face", () => {
  it("asks for it once, at both weights a label takes, at the atlas's size", async () => {
    const font = await fresh();
    void font.loadLabelFont();
    void font.loadLabelFont();
    expect(asked).toEqual([
      '400 64px "Inter", "Inter Fallback"',
      '700 64px "Inter", "Inter Fallback"',
    ]);
  });

  it("is not ready until both weights have loaded", async () => {
    const font = await fresh();
    const loaded = font.loadLabelFont();
    expect(font.labelFontReady()).toBe(false);
    pending[0].resolve();
    await tick();
    expect(font.labelFontReady()).toBe(false);
    pending[1].resolve();
    await loaded;
    expect(font.labelFontReady()).toBe(true);
  });

  it("is ready once a load fails, so labels draw in what there is rather than never", async () => {
    const font = await fresh();
    const loaded = font.loadLabelFont();
    pending[0].reject();
    await loaded;
    expect(font.labelFontReady()).toBe(true);
  });

  it("gives up on a face that never answers after the bound", async () => {
    vi.useFakeTimers();
    const font = await fresh();
    const loaded = font.loadLabelFont();
    await vi.advanceTimersByTimeAsync(font.LABEL_FONT_WAIT_MS - 1);
    expect(font.labelFontReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await loaded;
    expect(font.labelFontReady()).toBe(true);
  });

  it("is ready at once where the document can load no fonts", async () => {
    vi.stubGlobal("document", { documentElement: {} });
    const font = await fresh();
    await font.loadLabelFont();
    expect(font.labelFontReady()).toBe(true);
  });
});
