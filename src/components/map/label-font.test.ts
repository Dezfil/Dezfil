import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The label face and when labels may draw, against a stand-in document whose
 * font loads this test settles by hand. Each case imports the module afresh:
 * readiness is the page's, held once per document.
 *
 * The stand-in declares its faces as a stylesheet does, one per subset of
 * the alphabet, and answers a load by font name as a browser does: with the
 * face that covers a space, the Latin one, and no other.
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

/** A declared face: its family, weight and style as a stylesheet gives
 * them, the first character of its subset, and its load, settled by hand. */
interface Face {
  family: string;
  weight: string;
  style: string;
  covers: string;
  loads: number;
  settle: Deferred;
  load(): Promise<unknown>;
}

function face(family: string, weight: string, covers: string, style = "normal"): Face {
  const settle = deferred();
  const declared: Face = {
    family, weight, style, covers, loads: 0, settle,
    load: () => { declared.loads += 1; return settle.promise; },
  };
  return declared;
}

/** Inter as the app declares it: one variable face per subset. */
const interSubsets = () => [
  face("Inter", "100 900", " "),
  face("Inter", "100 900", "Ł"),
  face("Inter", "100 900", "Ж"),
];

let asked: string[];
let pending: Deferred[];
let declared: string;
let faces: Face[];

/** The stand-in font set: a load by name answered by the Latin face's own
 * load where one is declared, else by a load this test settles by hand. */
function fontSet() {
  return {
    load: (font: string) => {
      asked.push(font);
      const latin = faces.find((f) => f.covers === " " && font.includes(f.family));
      if (latin) return latin.load();
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    forEach: (visit: (f: Face) => void) => faces.forEach((f) => visit(f)),
  };
}

beforeEach(() => {
  vi.resetModules();
  asked = [];
  pending = [];
  faces = [];
  declared = '"Inter", "Inter Fallback"';
  vi.stubGlobal("document", { documentElement: {}, fonts: fontSet() });
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

  it("is ready once every load has settled, one failing, so labels draw in what there is rather than never", async () => {
    const font = await fresh();
    const loaded = font.loadLabelFont();
    pending[0].reject();
    await tick();
    expect(font.labelFontReady()).toBe(false);
    pending[1].resolve();
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

  it("holds labels with latin-ext and Cyrillic letters until those faces have loaded, not only the Latin one", async () => {
    faces = interSubsets();
    const [latin, latinExt, cyrillic] = faces;
    const font = await fresh();
    const loaded = font.loadLabelFont();
    latin.settle.resolve();
    await tick();
    expect(font.labelFontReady()).toBe(false);
    latinExt.settle.resolve();
    await tick();
    expect(font.labelFontReady()).toBe(false);
    cyrillic.settle.resolve();
    await loaded;
    expect(font.labelFontReady()).toBe(true);
  });

  it("is ready as soon as a Latin-only face has loaded", async () => {
    faces = [face("Inter", "100 900", " ")];
    const font = await fresh();
    const loaded = font.loadLabelFont();
    faces[0].settle.resolve();
    await loaded;
    expect(font.labelFontReady()).toBe(true);
  });

  it("loads only the faces a label draws with: the label's families, normal, at its weights", async () => {
    const latin = face("Inter", "100 900", " ");
    const normal = face("Inter", "400", "Ж");
    const bold = face("Inter", "bold", "Ж");
    const light = face("Inter", "300", "Ж");
    const italic = face("Inter", "400", "Ж", "italic");
    const quoted = face('"Inter Fallback"', "normal", "Ж");
    const other = face("DM Mono", "400", "Ж");
    faces = [latin, normal, bold, light, italic, quoted, other];
    for (const f of faces) f.settle.resolve();
    const font = await fresh();
    await font.loadLabelFont();
    expect(faces.map((f) => f.loads > 0)).toEqual([true, true, true, false, false, true, false]);
  });

  it("is ready at once where the document can load no fonts", async () => {
    vi.stubGlobal("document", { documentElement: {} });
    const font = await fresh();
    await font.loadLabelFont();
    expect(font.labelFontReady()).toBe(true);
  });
});

describe("the document's fonts, as what waits on every font waits for them", () => {
  it("settle when the font set does", async () => {
    let ready!: () => void;
    vi.stubGlobal("document", { documentElement: {}, fonts: { ...fontSet(), ready: new Promise<void>((resolve) => { ready = resolve; }) } });
    const font = await fresh();
    let settled = false;
    void font.documentFontsSettled().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    ready();
    await tick();
    expect(settled).toBe(true);
  });

  it("are given up on after the labels' own bound when a face never answers, so nothing waits forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { documentElement: {}, fonts: { ...fontSet(), ready: new Promise<void>(() => {}) } });
    const font = await fresh();
    let settled = false;
    void font.documentFontsSettled().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(font.LABEL_FONT_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
