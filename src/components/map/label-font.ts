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
 * **Labels wait for it.** A label's glyphs are drawn once into an atlas and
 * kept under the face's name. Drawn before the face has arrived, the canvas
 * silently substitutes a fallback, and that atlas would be kept for the life
 * of the page. So nothing draws a label until the face has loaded, at both
 * weights a label takes, or has failed to load; a face that never answers is
 * given up after {@link LABEL_FONT_WAIT_MS}, so labels never wait forever.
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
  const loads = Promise.all(
    LABEL_FONT_WEIGHTS.map((weight) => fonts.load(`${weight} 64px ${face}`)),
  ).then(
    () => undefined,
    () => undefined,
  );
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
