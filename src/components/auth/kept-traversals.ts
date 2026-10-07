/**
 * Back and Forward the page on screen keeps inside the document.
 *
 * The private workspace ends the document on every Back or Forward, so a
 * route cached for one account is never restored into another's. A page
 * may claim a traversal that stays on what it already shows (the Settings
 * tab holding unsaved text, stepping between entries of its own address):
 * nothing another account could have drawn comes back, and reloading
 * would only throw the text away. A keeper answers for the traversal that
 * just happened, from the address the browser now shows.
 */

type Keeper = () => boolean;

const keepers = new Set<Keeper>();

/** Claim traversals while the page is on screen; the returned function lets go. */
export function keepTraversals(keeper: Keeper): () => void {
  keepers.add(keeper);
  return () => { keepers.delete(keeper); };
}

/** Whether a page on screen keeps the traversal that just happened. */
export function traversalKept(): boolean {
  for (const keeper of keepers) {
    try { if (keeper()) return true; } catch { /* a keeper that fails keeps nothing */ }
  }
  return false;
}
