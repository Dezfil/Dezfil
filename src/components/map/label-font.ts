import { useEffect, useSyncExternalStore } from "react";

/**
 * The faces a map's text draws in, and whether each is there to draw with.
 *
 * **Labels name their face.** A text layer that names none draws in its
 * library's default, a fixed-width list headed by a font only some systems
 * carry: one face in a browser on one system, another in the server's
 * headless renderer, and a generic fixed-width face in the container. Labels
 * take a face the app serves from its own origin to every page, the render
 * route and air-gapped instances included, and it is the surface's to say
 * which: Inter in the workspace and on the render route, Archivo on a
 * published map and its embed, so the labels match the chrome they sit in.
 * It is read from the root's own declaration of that face, never from the
 * reading face, so the Typeface setting leaves labels alone and a map reads
 * the same for everyone on a given surface. Cluster counts keep their own
 * face on every surface, Inter at 400, as they always were.
 *
 * **Labels wait for their face, every alphabet of it.** A label's glyphs are
 * drawn once into an atlas and kept under the face's name: a glyph drawn
 * before its face has arrived is drawn in a fallback and stays so for the
 * life of the page. A face is declared as one file per subset of the
 * alphabet (Latin, Latin Extended, Cyrillic, Greek, Vietnamese), and a
 * browser fetches a subset only once text needs it; a load by the face's
 * name alone fetches the Latin one. So readiness loads every declared face
 * of the family that the text draws with (normal style, a weight it takes),
 * whatever the text says: "Łódź" or "Москва" then draws whole in the face,
 * and a label added later never meets a subset still on its way.
 *
 * Readiness is kept per family and set of weights, so a published map can
 * wait for Archivo at its label weights and for Inter at the counts' weight
 * at once, each drawing as soon as its own face is in. Nothing draws until
 * every load of its face has settled, loaded or failed; a face that never
 * answers is given up after {@link LABEL_FONT_WAIT_MS}, so nothing waits
 * forever.
 */

/** The faces a surface's labels may take: the custom property the
 * document's root carries each in, and what is asked for where the
 * document names none (a test document). */
export const LABEL_FACES = {
  inter: { property: "--font-inter", fallback: "Inter, sans-serif" },
  archivo: { property: "--font-archivo", fallback: "Archivo, sans-serif" },
} as const;
export type LabelFace = keyof typeof LABEL_FACES;

/** The weights a label draws at: normal and bold. */
export const LABEL_FONT_WEIGHTS = [600, 700] as const;

/** The face and weight cluster counts draw in, on every surface. */
export const COUNT_FACE: LabelFace = "inter";
export const COUNT_FONT_WEIGHTS = [400] as const;

/** How long text waits for its face before drawing with what there is. */
export const LABEL_FONT_WAIT_MS = 5_000;

const families = new Map<LabelFace, string>();
const ready = new Set<string>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const keyOf = (face: LabelFace, weights: readonly number[]) => `${face} ${weights.join(" ")}`;

/** The family a face is asked for by: the root's declaration of it. */
export function faceFamily(face: LabelFace): string {
  const known = families.get(face);
  if (known) return known;
  if (typeof document === "undefined") return LABEL_FACES[face].fallback;
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue(LABEL_FACES[face].property)
    .trim();
  const family = declared || LABEL_FACES[face].fallback;
  families.set(face, family);
  return family;
}

/** The families a CSS font list names, unquoted, in its order. */
export function fontFamilies(list: string): string[] {
  return list
    .split(",")
    .map((name) => name.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter((name) => name.length > 0);
}

/** Whether a face's declared weight covers a weight: a keyword, a number,
 * or a variable face's range. */
export function faceCoversWeight(declared: string, weight: number): boolean {
  const bounds = declared
    .trim()
    .split(/\s+/)
    .map((part) => (part === "normal" ? 400 : part === "bold" ? 700 : Number(part)));
  if (bounds.length === 0 || bounds.length > 2 || bounds.some((b) => !Number.isFinite(b))) return false;
  const [low, high = low] = bounds;
  return low <= weight && weight <= high;
}

/** The declared faces text draws with: of the family's names, normal
 * style, at a weight the text takes. */
function drawnFaces(fonts: FontFaceSet, names: readonly string[], weights: readonly number[]): FontFace[] {
  if (typeof fonts.forEach !== "function") return [];
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found: FontFace[] = [];
  fonts.forEach((declared) => {
    const [family] = fontFamilies(declared.family);
    if (!family || !wanted.has(family.toLowerCase())) return;
    if (declared.style !== "normal") return;
    if (!weights.some((weight) => faceCoversWeight(declared.weight, weight))) return;
    found.push(declared);
  });
  return found;
}

/** Whether text in this face at these weights may draw: the face has
 * loaded, failed, or timed out. */
export function fontReady(face: LabelFace, weights: readonly number[]): boolean {
  return ready.has(keyOf(face, weights));
}

/** Ask for a face at these weights once; settles when text in it may draw. */
export function loadFont(face: LabelFace, weights: readonly number[]): Promise<void> {
  const key = keyOf(face, weights);
  const started = loading.get(key);
  if (started) return started;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const settle = () => {
    if (ready.has(key)) return;
    ready.add(key);
    for (const listener of listeners) listener();
  };
  if (!fonts || typeof fonts.load !== "function") {
    settle();
    const done = Promise.resolve();
    loading.set(key, done);
    return done;
  }
  const family = faceFamily(face);
  const loads = Promise.allSettled([
    ...weights.map((weight) => fonts.load(`${weight} 64px ${family}`)),
    ...drawnFaces(fonts, fontFamilies(family), weights).map((declared) => declared.load()),
  ]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LABEL_FONT_WAIT_MS);
  });
  const done = Promise.race([loads, bound]).then(() => {
    clearTimeout(timer);
    settle();
  });
  loading.set(key, done);
  return done;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The document's fonts settled, or given up on after the labels' own bound.
 * The labels' readiness starts every subset of their face loading, so one
 * that never answers, even one no text on the page uses, would keep the
 * whole font set pending for good. Whatever waits on every font (the
 * server's image export) waits at most {@link LABEL_FONT_WAIT_MS} for it,
 * and then goes on with what there is, as the labels do.
 */
export function documentFontsSettled(): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.ready) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LABEL_FONT_WAIT_MS);
  });
  const settled = fonts.ready.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([settled, bound]).then(() => clearTimeout(timer));
}

/**
 * A face's family once text in it may draw, else null; asks for it on
 * first use. A layer keyed on it rebuilds its text when it arrives.
 */
function useFont(face: LabelFace, weights: readonly number[]): string | null {
  const isReady = useSyncExternalStore(subscribe, () => fontReady(face, weights), () => false);
  useEffect(() => {
    void loadFont(face, weights);
  }, [face, weights]);
  return isReady ? faceFamily(face) : null;
}

/** The surface's label face once labels may draw, else null. */
export function useLabelFont(face: LabelFace): string | null {
  return useFont(face, LABEL_FONT_WEIGHTS);
}

/** The cluster counts' face once counts may draw, else null. */
export function useCountFont(): string | null {
  return useFont(COUNT_FACE, COUNT_FONT_WEIGHTS);
}
