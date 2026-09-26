/**
 * Which application layer a deck.gl pick belongs to.
 *
 * Deck sublayer ids are namespaced off the app layer id — `:windowed`,
 * `:icon`, `:od`, `:cluster`, `:mvt` — so ownership is the id itself or a
 * namespaced descendant of it. Extracted from the canvas's click handler as
 * this feature's MapCanvas slice under the decomposition rule: the popup
 * path and the input picker's Select mode resolve the same owner, and two
 * copies of the rule is how they would come to disagree.
 */
export function pickOwner<L extends { id: string }>(
  layers: readonly L[],
  deckLayerId: string | null | undefined,
): L | undefined {
  if (!deckLayerId) return undefined;
  return layers.find(
    (l) => l.id === deckLayerId || deckLayerId.startsWith(`${l.id}:`),
  );
}
