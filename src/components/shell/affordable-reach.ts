/**
 * The reach the header card can afford.
 *
 * A surface lends the card a minimum width, its pane's right edge. That
 * minimum is a floor only while the row can pay for it: the actions
 * beside the card do not shrink, so a floor wider than the room they
 * leave would push them out of the viewport. The reach is therefore
 * clamped to the room the card's siblings leave, measured from the row
 * itself so the run dock's status text, the builder's search control and
 * a narrower window all count the moment they appear.
 *
 * A sibling may give way for the reach: one marked `data-header-yields`
 * (the builder's search field) narrows, down to its minimum width, by
 * what the card needs beyond the room the row leaves at rest. Its rest
 * and its minimum are measured, never copied, so the reserve the actions
 * hold is what they need at the least; the card gives up reach only
 * past that, and nothing else in the row is squeezed for it.
 */

export type RowGeometry = {
  /** The card's left edge, viewport px. */
  cardLeft: number;
  /** The row's content-box right edge, viewport px. */
  contentRight: number;
  /** The row's column gap between flex items. */
  gap: number;
  /** The widths of the row's other flex items at rest, whatever their order. */
  siblingWidths: number[];
  /** What the siblings that yield can give together: each one's rest
   * width less its minimum. */
  give?: number;
};

/** The widest the card may be before a sibling would leave the row. */
export function roomForCard(g: RowGeometry): number {
  const others = g.siblingWidths.reduce((sum, w) => sum + w, 0);
  return g.contentRight - g.cardLeft - others - g.gap * g.siblingWidths.length;
}

/** The card's minimum width: the pane's reach, no wider than the room,
 * counting what the yielding siblings can give. */
export function affordableReach(paneRight: number, g: RowGeometry): number {
  return Math.max(0, Math.min(paneRight - g.cardLeft, roomForCard(g) + (g.give ?? 0)));
}

/** What each yielding sibling gives, in row order, so the card's width
 * fits: the shortfall from the room at rest, each giving up to its rest
 * width less its minimum before the next gives anything. */
export function shareOut(cardWidth: number, g: RowGeometry, yielding: { width: number; least: number }[]): number[] {
  let short = Math.max(0, cardWidth - roomForCard(g));
  return yielding.map(({ width, least }) => {
    const given = Math.min(short, Math.max(0, width - least));
    short -= given;
    return given;
  });
}

/** The row's siblings that may give way for the card's reach. */
export function yieldingItems(card: HTMLElement): HTMLElement[] {
  const row = card.parentElement;
  return row ? rowItems(row).filter((item) => item !== card && item.hasAttribute("data-header-yields")) : [];
}

/** A yielding sibling's rest and least widths, read with nothing given. */
export function yieldOf(item: HTMLElement): { width: number; least: number } {
  const width = item.getBoundingClientRect().width;
  const least = parseFloat(getComputedStyle(item).minWidth);
  return { width, least: Number.isFinite(least) ? Math.min(width, least) : width };
}

/** The row's flex items, looking through `display: contents` slots the
 * shell uses as portal targets: their children are the items. */
export function rowItems(row: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (getComputedStyle(child).display === "contents") {
      for (const inner of Array.from(child.children)) {
        if (inner instanceof HTMLElement) items.push(inner);
      }
    } else {
      items.push(child);
    }
  }
  return items;
}

/** Reads the row around the card at rest: any width the yielding siblings
 * gave is taken back and the card holds no reach while the row is read,
 * so nothing in it is squeezed into the reading. Null before the card is
 * in a row. */
export function measureRow(card: HTMLElement): RowGeometry | null {
  const row = card.parentElement;
  if (!row) return null;
  const yielding = yieldingItems(card);
  for (const item of yielding) item.style.removeProperty("flex-basis");
  const held = card.style.minWidth;
  card.style.removeProperty("min-width");
  try {
    const style = getComputedStyle(row);
    const rect = row.getBoundingClientRect();
    return {
      cardLeft: card.getBoundingClientRect().left,
      contentRight: rect.right - parseFloat(style.paddingRight),
      gap: parseFloat(style.columnGap) || 0,
      siblingWidths: rowItems(row)
        .filter((item) => item !== card)
        .map((item) => item.getBoundingClientRect().width),
      give: yielding.map(yieldOf).reduce((sum, { width, least }) => sum + width - least, 0),
    };
  } finally {
    if (held) card.style.minWidth = held;
  }
}

/** Narrows the yielding siblings by what the card's width needs of them,
 * or gives them back their rest when it needs nothing (`cardWidth` null). */
export function applyYield(card: HTMLElement, g: RowGeometry | null, cardWidth: number | null): void {
  const yielding = yieldingItems(card);
  const sizes = yielding.map(yieldOf);
  const given = g && cardWidth !== null ? shareOut(cardWidth, g, sizes) : sizes.map(() => 0);
  yielding.forEach((item, index) => {
    if (given[index] > 0) item.style.flexBasis = `${sizes[index].width - given[index]}px`;
    else item.style.removeProperty("flex-basis");
  });
}
