/**
 * The leave guard: what would be lost by leaving the tab on screen. A
 * card holds the page only while it shows unsaved typed text (its Save
 * line); a value kept as it changes never does. Anything else that must
 * not be dropped silently (a new token's secret on screen) holds it with
 * its own sentence. Leaving then asks once, naming the cards.
 */

export interface GuardEntry {
  /** The card's title, as its heading shows it. */
  readonly title: string;
  /** A sentence of its own, said instead of naming the card. */
  readonly note?: string;
}

export interface GuardMessage {
  readonly title: string;
  readonly body: readonly string[];
  readonly discard: string;
  readonly keep: string;
}

export function guardMessage(entries: readonly GuardEntry[]): GuardMessage | null {
  if (!entries.length) return null;
  const names: string[] = [], notes: string[] = [];
  for (const entry of entries) {
    if (entry.note) { if (!notes.includes(entry.note)) notes.push(entry.note); }
    else if (!names.includes(entry.title)) names.push(entry.title);
  }
  const body: string[] = [];
  if (names.length === 1) body.push(`${names[0]} has changes that are not saved.`);
  else if (names.length > 1) body.push(`${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} have changes that are not saved.`);
  return { title: "Discard unsaved changes?", body: [...body, ...notes], discard: "Discard changes", keep: "Keep editing" };
}

const same = (a: GuardEntry | null, b: GuardEntry | null) =>
  a === b || (!!a && !!b && a.title === b.title && a.note === b.note);

/** What the tab on screen holds, card by card, in the order the cards
 * first reported, which is the order they are drawn. */
export class LeaveGuard {
  private readonly entries = new Map<string, GuardEntry | null>();
  private readonly listeners = new Set<() => void>();

  /** A card reports whether it holds the page (an entry) or not (null). */
  set(id: string, entry: GuardEntry | null): void {
    const previous = this.entries.get(id) ?? null;
    this.entries.set(id, entry);
    if (!same(previous, entry)) this.notify();
  }

  /** A card that leaves the page holds nothing. */
  remove(id: string): void {
    const previous = this.entries.get(id) ?? null;
    if (this.entries.delete(id) && previous) this.notify();
  }

  holding(): boolean {
    for (const entry of this.entries.values()) if (entry) return true;
    return false;
  }

  message(): GuardMessage | null {
    return guardMessage([...this.entries.values()].filter((entry): entry is GuardEntry => !!entry));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
