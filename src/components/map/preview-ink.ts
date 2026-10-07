/** Today's kelp, the ink before anything has computed. */
const KELP = { light: "#0d7d5c", dark: "#45c58f" } as const;

/**
 * The one ink a feature preview draws in: the interface's accent, read
 * from the tokens where the preview stands, so the person's Color reaches
 * it as it reaches every other accent. The map takes a concrete colour, so
 * the token is read when the features land; before anything has computed
 * it is today's kelp for the theme.
 */
export function previewInk(host: Element | null, theme: "dark" | "light"): string {
  if (!host || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return KELP[theme];
  return window.getComputedStyle(host).getPropertyValue("--accent").trim() || KELP[theme];
}
