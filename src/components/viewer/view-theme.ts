/**
 * The reader's effective theme on a published page.
 *
 * Retired per-link memory: a reader's switch lasts for the current page
 * load and nothing is stored. The reasoning is the shared link — one URL
 * handed to many people has to open the same way for all of them, and an
 * author's change has to reach a reader who once flipped the toggle.
 * Under the old memory it never did: that browser kept its remembered
 * choice forever, with no way to clear it, which is why changing the
 * theme appeared to require republishing (a fresh token simply orphaned
 * the old key).
 *
 * Nothing here reads storage, and the old key is not migrated or cleared
 * — a value left behind is simply never consulted.
 */

export type ViewTheme = "light" | "dark";
