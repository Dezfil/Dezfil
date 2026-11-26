import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The faces a map's text draws in and whether each is there to draw with,
 * against a stand-in document whose font loads this test settles by hand.
 * Each case imports the module afresh: readiness is the page's, held once
 * per document.
 *
 * The stand-in declares its faces as a stylesheet does, one per subset of
 * the alphabet, and answers a load by font name as a browser does: with the
 * face of that family that covers a space, the Latin one, and no other.
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

/** A face as the app declares it: one variable face per subset. */
const subsets = (family: string) => [
  face(family, "100 900", " "),
  face(family, "100 900", "Ł"),
  face(family, "100 900", "Ж"),
];

let asked: string[];
let pending: Deferred[];
let declared: Record<string, string>;
let faces: Face[];

/** The stand-in font set: a load by name answered by the Latin face of the
 * family it names, where one is declared, else by a load this test settles
 * by hand. */
function fontSet() {
  return {
    load: (font: string) => {
      asked.push(font);
      const latin = faces.find((f) => f.covers === " " && font.includes(`"${f.family}"`));
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
  // The root as the app's document carries it, the Typeface setting at
  // "System": the reading face moves, the label faces do not.
  declared = {
    "--font-inter": '"Inter", "Inter Fallback"',
    "--font-archivo": '"Archivo", "Archivo Fallback"',
    "--font-ui": "system-ui, sans-serif",
  };
  vi.stubGlobal("document", { documentElement: {}, fonts: fontSet() });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => (name in declared ? ` ${declared[name]}` : ""),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fresh = () => import("./label-font");
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the face a surface's labels draw in", () => {
  it("is Inter in the workspace and on the render route, Archivo on a published map, as the root declares each", async () => {
    const font = await fresh();
    expect(font.faceFamily("inter")).toBe('"Inter", "Inter Fallback"');
    expect(font.faceFamily("archivo")).toBe('"Archivo", "Archivo Fallback"');
  });

  it("is not the reading face, so the Typeface setting leaves labels alone", async () => {
    const font = await fresh();
    for (const face of ["inter", "archivo"] as const) {
      expect(font.faceFamily(face)).not.toContain("system-ui");
    }
  });

  it("falls back to the face by name where the document declares none", async () => {
    declared = {};
    const font = await fresh();
    expect(font.faceFamily("inter")).toBe("Inter, sans-serif");
    expect(font.faceFamily("archivo")).toBe("Archivo, sans-serif");
  });
});

describe("labels wait for their face", () => {
  it("asks for it once, at both weights a label takes, at the atlas's size", async () => {
    const font = await fresh();
    void font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    void font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    expect(asked).toEqual([
      '600 64px "Archivo", "Archivo Fallback"',
      '700 64px "Archivo", "Archivo Fallback"',
    ]);
  });

  it("is not ready until both weights have loaded", async () => {
    const font = await fresh();
    const loaded = font.loadFont("inter", font.LABEL_FONT_WEIGHTS);
    expect(font.fontReady("inter", font.LABEL_FONT_WEIGHTS)).toBe(false);
    pending[0].resolve();
    await tick();
    expect(font.fontReady("inter", font.LABEL_FONT_WEIGHTS)).toBe(false);
    pending[1].resolve();
    await loaded;
    expect(font.fontReady("inter", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });

  it("is ready once every load has settled, one failing, so labels draw in what there is rather than never", async () => {
    const font = await fresh();
    const loaded = font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    pending[0].reject();
    await tick();
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    pending[1].resolve();
    await loaded;
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });

  it("draws in the face that arrives late but within the bound: ready on its arrival, not on the bound", async () => {
    vi.useFakeTimers();
    faces = subsets("Archivo");
    const font = await fresh();
    const loaded = font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    await vi.advanceTimersByTimeAsync(font.LABEL_FONT_WAIT_MS - 1_000);
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    for (const f of faces) f.settle.resolve();
    await loaded;
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
    // Every subset had loaded when labels were let draw: nothing in the fallback.
    expect(faces.every((f) => f.loads > 0)).toBe(true);
  });

  it("gives up on a face that never answers at the bound, so labels draw in the fallback rather than never", async () => {
    vi.useFakeTimers();
    const font = await fresh();
    const loaded = font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    await vi.advanceTimersByTimeAsync(font.LABEL_FONT_WAIT_MS - 1);
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await loaded;
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });

  it("holds labels with latin-ext and Cyrillic letters until those subsets of their own face have loaded", async () => {
    faces = [...subsets("Archivo"), ...subsets("Inter")];
    const [latin, latinExt, cyrillic] = faces;
    const font = await fresh();
    const loaded = font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    latin.settle.resolve();
    await tick();
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    latinExt.settle.resolve();
    await tick();
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    cyrillic.settle.resolve();
    await loaded;
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
    // Another family's subsets are another family's business.
    expect(faces.slice(3).map((f) => f.loads)).toEqual([0, 0, 0]);
  });

  it("is ready as soon as a Latin-only face has loaded", async () => {
    faces = [face("Inter", "100 900", " ")];
    const font = await fresh();
    const loaded = font.loadFont("inter", font.LABEL_FONT_WEIGHTS);
    faces[0].settle.resolve();
    await loaded;
    expect(font.fontReady("inter", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });

  it("loads only the faces a label draws with: the surface's family, normal, at the label's weights", async () => {
    const latin = face("Inter", "100 900", " ");
    const regular = face("Inter", "400", "Ж");
    const semibold = face("Inter", "600", "Ж");
    const bold = face("Inter", "bold", "Ж");
    const light = face("Inter", "300", "Ж");
    const italic = face("Inter", "600", "Ж", "italic");
    const quoted = face('"Inter Fallback"', "normal", "Ж");
    const other = face("Archivo", "100 900", "Ж");
    faces = [latin, regular, semibold, bold, light, italic, quoted, other];
    for (const f of faces) f.settle.resolve();
    const font = await fresh();
    await font.loadFont("inter", font.LABEL_FONT_WEIGHTS);
    // The fallback face is declared at normal (400), which no label weight is.
    expect(faces.map((f) => f.loads > 0)).toEqual([true, false, true, true, false, false, false, false]);
  });

  it("is ready at once where the document can load no fonts", async () => {
    vi.stubGlobal("document", { documentElement: {} });
    const font = await fresh();
    await font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });
});

describe("a map with labels and cluster counts", () => {
  it("asks for the counts' own face, Inter at 400, whatever face the labels take", async () => {
    const font = await fresh();
    expect(font.COUNT_FACE).toBe("inter");
    expect([...font.COUNT_FONT_WEIGHTS]).toEqual([400]);
    void font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    void font.loadFont(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS);
    expect(asked).toEqual([
      '600 64px "Archivo", "Archivo Fallback"',
      '700 64px "Archivo", "Archivo Fallback"',
      '400 64px "Inter", "Inter Fallback"',
    ]);
  });

  it("holds each to its own face: counts draw once Inter is in while the labels still wait for Archivo", async () => {
    faces = [...subsets("Archivo"), ...subsets("Inter")];
    const font = await fresh();
    const labels = font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    const counts = font.loadFont(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS);
    for (const f of faces.slice(3)) f.settle.resolve();
    await counts;
    expect(font.fontReady(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS)).toBe(true);
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    for (const f of faces.slice(0, 3)) f.settle.resolve();
    await labels;
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });

  it("lets neither wait past the bound for the other: a stalled label face holds no count, and both settle within it", async () => {
    vi.useFakeTimers();
    faces = [...subsets("Archivo"), ...subsets("Inter")];
    const font = await fresh();
    const labels = font.loadFont("archivo", font.LABEL_FONT_WEIGHTS);
    const counts = font.loadFont(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS);
    for (const f of faces.slice(3)) f.settle.resolve();
    await counts;
    expect(font.fontReady(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS)).toBe(true);
    await vi.advanceTimersByTimeAsync(font.LABEL_FONT_WAIT_MS - 1);
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await labels;
    expect(font.fontReady("archivo", font.LABEL_FONT_WEIGHTS)).toBe(true);
  });

  it("keeps the workspace's labels and counts apart too, one family at two weights", async () => {
    const font = await fresh();
    const labels = font.loadFont("inter", font.LABEL_FONT_WEIGHTS);
    void font.loadFont(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS);
    pending[2].resolve();
    await tick();
    expect(font.fontReady(font.COUNT_FACE, font.COUNT_FONT_WEIGHTS)).toBe(true);
    expect(font.fontReady("inter", font.LABEL_FONT_WEIGHTS)).toBe(false);
    pending[0].resolve();
    pending[1].resolve();
    await labels;
    expect(font.fontReady("inter", font.LABEL_FONT_WEIGHTS)).toBe(true);
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
