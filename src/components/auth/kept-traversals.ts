/**
 * Back and Forward the page on screen keeps inside the document, or sent
 * itself to leave it.
 *
 * The private workspace ends the document on every Back or Forward, so a
 * route cached for one account is never restored into another's. A page
 * may claim a traversal that stays on what it already shows (the Settings
 * tab holding unsaved text, stepping between entries of its own address):
 * nothing another account could have drawn comes back, and reloading
 * would only throw the text away. A keeper answers for the traversal that
 * just happened, from the address the browser now shows.
 *
 * A page may also claim the traversal it sent itself to leave, once the
 * person let go of what it held (the Settings tab's Discard over Back).
 * The workspace ends the document on that step before anyone else hears
 * it, so the router never starts restoring a route the reload throws away.
 */

type Claim = () => boolean;

const keepers = new Set<Claim>();
const enders = new Set<Claim>();

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

/** Claim the traversals the page sends to leave; the returned function lets go. */
export function endTraversals(ender: Claim): () => void {
  return claim(enders, ender);
}

/** Whether a page on screen sent the traversal that just happened to leave the document. */
export function traversalEnds(): boolean {
  return claimed(enders);
}
