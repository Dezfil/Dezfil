/**
 * Back and Forward the page on screen keeps inside the document, or takes
 * itself.
 *
 * The private workspace ends the document on every Back or Forward, so a
 * route cached for one account is never restored into another's, and it
 * stops the step before the router hears it, so the router never starts
 * restoring a route the reload throws away. A page may claim a traversal
 * that stays on what it already shows (the Settings tab holding unsaved
 * text, stepping between entries of its own address): nothing another
 * account could have drawn comes back, and reloading would only throw the
 * text away. A keeper answers for the traversal that just happened, from
 * the address the browser now shows.
 *
 * A page whose unsaved work the browser's own question guards takes Back
 * and Forward itself: it stops the step and reloads, and the person may
 * still choose to stay on the page as it is. The workspace stands aside
 * for it rather than ending the document before that question is asked.
 */

type Claim = () => boolean;

const keepers = new Set<Claim>();
const takers = new Set<Claim>();

function claim(claims: Set<Claim>, answer: Claim): () => void {
  claims.add(answer);
  return () => { claims.delete(answer); };
}

function claimed(claims: Set<Claim>): boolean {
  for (const answer of claims) {
    try { if (answer()) return true; } catch { /* a claim that fails claims nothing */ }
  }
  return false;
}

/** Claim traversals while the page is on screen; the returned function lets go. */
export function keepTraversals(keeper: Claim): () => void {
  return claim(keepers, keeper);
}

/** Whether a page on screen keeps the traversal that just happened. */
export function traversalKept(): boolean {
  return claimed(keepers);
}

/** Take Back and Forward while the page asks the browser's own question; the returned function lets go. */
export function takeTraversals(taker: Claim): () => void {
  return claim(takers, taker);
}

/** Whether a page on screen takes the traversal that just happened itself. */
export function traversalTaken(): boolean {
  return claimed(takers);
}
