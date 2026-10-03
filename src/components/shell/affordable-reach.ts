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
 */

export type RowGeometry = {
  /** The card's left edge, viewport px. */
  cardLeft: number;
  /** The row's content-box right edge, viewport px. */
  contentRight: number;
  /** The row's column gap between flex items. */
  gap: number;
  /** The widths of the row's other flex items, whatever their order. */
  siblingWidths: number[];
};

/** The widest the card may be before a sibling would leave the row. */
export function roomForCard(g: RowGeometry): number {
  const others = g.siblingWidths.reduce((sum, w) => sum + w, 0);
  return g.contentRight - g.cardLeft - others - g.gap * g.siblingWidths.length;
}

/** The card's minimum width: the pane's reach, no wider than the room. */
export function affordableReach(paneRight: number, g: RowGeometry): number {
  return Math.max(0, Math.min(paneRight - g.cardLeft, roomForCard(g)));
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

/** Reads the row around the card. Null before the card is in a row. */
export function measureRow(card: HTMLElement): RowGeometry | null {
  const row = card.parentElement;
  if (!row) return null;
  const style = getComputedStyle(row);
  const rect = row.getBoundingClientRect();
  return {
    cardLeft: card.getBoundingClientRect().left,
    contentRight: rect.right - parseFloat(style.paddingRight),
    gap: parseFloat(style.columnGap) || 0,
    siblingWidths: rowItems(row)
      .filter((item) => item !== card)
      .map((item) => item.getBoundingClientRect().width),
  };
}
