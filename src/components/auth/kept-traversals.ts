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
 * A page with unsaved work may take Back and Forward itself: the step is
 * stopped, the page asks, and the person may still choose to stay on the
 * page as it is. A browser runs a window's popstate listeners in the
 * order they were added, capture or not, and the router adds its own
 * after the workspace's and before any page's, which mounts later; so
 * only the workspace can stop a step before the router restores the
 * route it arrived at. It stops every kept or taken step there, reads
 * the session, and only when the session still names the document's
 * account hands a kept step on to the router and a taken one to the page
 * that took it, rather than ending the document before the question is
 * asked. A page that took a step and lets it go on hands it back, and
 * the workspace ends the document at the address the browser shows, as
 * it does for any step nobody keeps.
 */

type Claim = () => boolean;
/** How a page handles a step it takes: the step, already stopped before the router. */
type Take = (event: Event) => void;

const keepers = new Set<Claim>();
const takers = new Set<{ readonly claim: Claim; readonly take: Take }>();
const enders = new Set<() => void>();

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

/** Take Back and Forward while the page asks its own question or the
 * browser's: `take` handles each step `claim` claims. The returned
 * function lets go. */
export function takeTraversals(claim: Claim, take: Take): () => void {
  const taker = { claim, take };
  takers.add(taker);
  return () => { takers.delete(taker); };
}

/** How the page on screen handles the traversal that just happened, when it takes it; null when no page does. */
export function traversalTaker(): Take | null {
  for (const taker of takers) {
    try { if (taker.claim()) return taker.take; } catch { /* a claim that fails claims nothing */ }
  }
  return null;
}

/** Whether a page on screen takes the traversal that just happened itself. */
export function traversalTaken(): boolean {
  return traversalTaker() !== null;
}

/** How the document ends on a step nobody keeps, offered by the private
 * workspace while it watches; the returned function withdraws it. */
export function endTraversalsWith(end: () => void): () => void {
  enders.add(end);
  return () => { enders.delete(end); };
}

/** A page lets a step it took go on: the document ends at the address the
 * browser shows, as on any step nobody keeps. False when nothing watches
 * the document to end it. */
export function letTraversalGo(): boolean {
  if (!enders.size) return false;
  for (const end of [...enders]) end();
  return true;
}
