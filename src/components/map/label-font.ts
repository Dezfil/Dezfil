import { useEffect, useSyncExternalStore } from "react";

/**
 * The face map labels draw in, and whether it is there to draw with.
 *
 * **Labels name their face.** A text layer that names none draws in its
 * library's default, a fixed-width list headed by a font only some systems
 * carry: one face in a browser on one system, another in the server's
 * headless renderer, and a generic fixed-width face in the container. Labels
 * take the product's own interface face instead, which the app serves from
 * its own origin to every page, the render route and air-gapped instances
 * included.
 *
 * **Labels wait for it, every alphabet of it.** A label's glyphs are drawn
 * once into an atlas and kept under the face's name: a glyph drawn before its
 * face has arrived is drawn in a fallback and stays so for the life of the
 * page. The face is declared as one file per subset of the alphabet (Latin,
 * Latin Extended, Cyrillic, Greek, Vietnamese), and a browser fetches a
 * subset only once text needs it; a load by the face's name alone fetches the
 * Latin one. So readiness loads every declared face of the label's families
 * that a label draws with (normal style, a weight labels take), whatever the
 * labels say: "Łódź" or "Москва" then draws whole in the face, and a label
 * added later never meets a subset still on its way. Nothing draws a label
 * until every one of those loads has settled, loaded or failed; a face that
 * never answers is given up after {@link LABEL_FONT_WAIT_MS}, so labels never
 * wait forever.
 */

/** The custom property the document's root carries the interface face in. */
export const LABEL_FONT_PROPERTY = "--font-inter";

/** What labels ask for where the document names no face (a test document). */
export const LABEL_FONT_FALLBACK = "Inter, sans-serif";

/** The weights a label draws at: normal and bold. */
export const LABEL_FONT_WEIGHTS = [400, 700] as const;

/** How long labels wait for their face before drawing with what there is. */
export const LABEL_FONT_WAIT_MS = 5_000;

let family: string | null = null;
let ready = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** The face labels draw in: the document's interface face, as declared. */
export function labelFontFamily(): string {
  if (family) return family;
  if (typeof document === "undefined") return LABEL_FONT_FALLBACK;
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue(LABEL_FONT_PROPERTY)
    .trim();
  family = declared || LABEL_FONT_FALLBACK;
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

/** The declared faces a label draws with: of the label's families, normal
 * style, at a weight labels take. */
function labelFaces(fonts: FontFaceSet, families: readonly string[]): FontFace[] {
  if (typeof fonts.forEach !== "function") return [];
  const wanted = new Set(families.map((name) => name.toLowerCase()));
  const found: FontFace[] = [];
  fonts.forEach((declared) => {
    const [family] = fontFamilies(declared.family);
    if (!family || !wanted.has(family.toLowerCase())) return;
    if (declared.style !== "normal") return;
    if (!LABEL_FONT_WEIGHTS.some((weight) => faceCoversWeight(declared.weight, weight))) return;
    found.push(declared);
  });
  return found;
}

/** Whether labels may draw: their face has loaded, failed, or timed out. */
export function labelFontReady(): boolean {
  return ready;
}

/** Ask for the label face once; settles when labels may draw. */
export function loadLabelFont(): Promise<void> {
  if (loading) return loading;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const settle = () => {
    if (ready) return;
    ready = true;
    for (const listener of listeners) listener();
  };
  if (!fonts || typeof fonts.load !== "function") {
    settle();
    loading = Promise.resolve();
    return loading;
  }
  const face = labelFontFamily();
  const loads = Promise.allSettled([
    ...LABEL_FONT_WEIGHTS.map((weight) => fonts.load(`${weight} 64px ${face}`)),
    ...labelFaces(fonts, fontFamilies(face)).map((declared) => declared.load()),
  ]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LABEL_FONT_WAIT_MS);
  });
  loading = Promise.race([loads, bound]).then(() => {
    clearTimeout(timer);
    settle();
  });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The label face once labels may draw, else null; asks for the face on
 * first use. A component keyed on it rebuilds its labels when it arrives.
 */
export function useLabelFont(): string | null {
  const isReady = useSyncExternalStore(subscribe, labelFontReady, () => false);
  useEffect(() => {
    void loadLabelFont();
  }, []);
  return isReady ? labelFontFamily() : null;
}
