import { defaultLook, LOOK_KEYS, lookAttributes, lookChoices, normalizeLook, type Look, type LookKey } from "@/lib/look";
import { FADE_MS, SaveUnit, UNDO_MS, type UnitNote, type UnitSnapshot, type Value } from "./save-unit";

/**
 * The Appearance tab's own logic, framework-free: its cards and rows, the
 * one writer every look write goes through, what the page shows while
 * picks are on their way, and the tab-wide Reset to Dezfil's default with
 * its Undo. A card's own saving, Reset and Undo are the frame's save unit.
 */

export interface LookRow {
  readonly key: LookKey;
  readonly label: string;
  /** The row's address inside the tab. */
  readonly id: string;
  /** Words the search also finds the row by. */
  readonly keys: string;
}

export interface LookCard {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly LookRow[];
}

/** The cards, top to bottom: Color leads, as it changes the most. A card
 * left with one row keeps its place and names only what it holds. */
export const LOOK_CARDS: readonly LookCard[] = [
  { id: "appearance-color", title: "Color and contrast", rows: [
    { key: "color", label: "Color", id: "set-color",
      keys: "colour tint hue accent highlight kelp green harbor blue heather violet purple lavender slate grey gray graphite" },
    { key: "contrast", label: "Contrast", id: "set-contrast", keys: "borders legibility readable muted faint accessibility" },
  ] },
  { id: "appearance-background", title: "Background", rows: [
    { key: "background", label: "Background", id: "set-background",
      keys: "pattern texture sheet wallpaper chart atlantic coastline plain graticule grid crosses hex hexagon lattice" },
  ] },
  { id: "appearance-text", title: "Text", rows: [
    { key: "font", label: "Typeface", id: "set-typeface", keys: "font family inter system type letters" },
  ] },
  { id: "appearance-layout", title: "Layout", rows: [
    { key: "corners", label: "Corners", id: "set-corners", keys: "radius rounded soft edges" },
    { key: "rail", label: "Side menu", id: "set-side-menu", keys: "rail sidebar navigation hover labels icons pin expanded open" },
  ] },
];

const CHOICE_LABELS: Readonly<Record<LookKey, Readonly<Record<string, string>>>> = {
  color: { kelp: "Kelp", harbor: "Harbor", heather: "Heather", slate: "Slate" },
  contrast: { standard: "Standard", more: "More contrast" },
  font: { inter: "Inter", system: "System" },
  background: { atlantic: "Atlantic chart", plain: "Plain", graticule: "Graticule", hex: "Hex lattice" },
  corners: { rounded: "Rounded", soft: "Soft" },
  rail: { hover: "Opens on hover", open: "Always open", icons: "Icons only" },
};

/** A choice as the tab names it. */
export function choiceLabel(key: LookKey, value: string): string {
  return CHOICE_LABELS[key][value] ?? value;
}

/** A pick's key in a card's save unit: the API's own name for it, so a
 * refusal naming `look.color` lands on the Color row. */
export const unitKey = (key: LookKey) => `look.${key}`;
const pickOf = (key: string) => key.slice("look.".length) as LookKey;

export type LookSend = (patch: Partial<Look>) => Promise<Look>;

/**
 * Every look write on the tab, one at a time in the order they were made:
 * a card's pick, a card's Reset and Undo, and the tab-wide reset and its
 * Undo all patch the same slice, so a reset made while a pick is on its
 * way lands after it and the server ends where the screen does.
 */
export class LookWriter {
  /** Settles when the last write made so far has answered. */
  private last: Promise<void> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly send: LookSend) {}

  readonly write = (patch: Partial<Look>): Promise<Look> => {
    // Nothing on its way: the write goes now, in the same task as the pick.
    const next = this.waiting === 0 ? this.send(patch) : this.last.then(() => this.send(patch));
    this.waiting += 1;
    const settled = () => { this.waiting -= 1; };
    this.last = next.then(settled, settled);
    return next;
  };
}

/** A card's save unit over the look's slice. The look admits its choices
 * only, so a Reset writes each pick's default itself. */
export function lookUnit(card: LookCard, kept: Look, writer: LookWriter): SaveUnit {
  const keys = card.rows.map(row => row.key);
  return new SaveUnit({
    title: card.title,
    controls: keys.map(key => ({ key: unitKey(key), kind: "choice" as const, defaultValue: lookChoices(key)[0] })),
    kept: Object.fromEntries(keys.map(key => [unitKey(key), kept[key]])),
    write: async patch => {
      const look = await writer.write(Object.fromEntries(Object.entries(patch).map(([key, value]) =>
        [pickOf(key), value ?? lookChoices(pickOf(key))[0]])) as Partial<Look>);
      return unitValues(look, keys);
    },
  });
}

/** What the server reports, as a card's unit keeps it. */
export function unitValues(look: Look, keys: readonly LookKey[] = LOOK_KEYS): Record<string, Value> {
  return Object.fromEntries(keys.map(key => [unitKey(key), look[key]]));
}

/** What the page shows: each row's pick the moment it is made, or what is
 * kept for a row a refusal put a red line under. */
export function shownLook(snapshots: readonly Pick<UnitSnapshot, "values" | "kept" | "errors">[]): Look {
  const picks: Record<string, unknown> = {};
  for (const snapshot of snapshots) {
    for (const [key, value] of Object.entries(snapshot.values)) {
      picks[pickOf(key)] = key in snapshot.errors ? snapshot.kept[key] : value;
    }
  }
  return normalizeLook(picks);
}

/** Stamp a look on the document's root: one attribute per pick that
 * differs from the default, every other look attribute removed. */
export function stampLook(root: Element, look: Look): void {
  const attributes: Record<string, string | undefined> = lookAttributes(look);
  for (const key of LOOK_KEYS) {
    const name = `data-look-${key}`, value = attributes[name];
    if (value === undefined) root.removeAttribute(name);
    else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
}

const differs = (look: Look) => LOOK_KEYS.some(key => look[key] !== lookChoices(key)[0]);

export interface LookResetSnapshot {
  /** A write of the reset or its Undo is on its way. */
  readonly busy: boolean;
  readonly leaving: boolean;
  readonly note: UnitNote | null;
  /** Where focus should go, once per seq. */
  readonly focus: { readonly to: "undo" | "reset"; readonly seq: number } | null;
}

interface Offer { readonly previous: Partial<Look>; timer: ReturnType<typeof setTimeout> | null; held: Set<"focus" | "pointer">; expired: boolean; leaving: boolean }

/**
 * The tab-wide Reset to Dezfil's default: every pick back in one write,
 * then Undo in its place for six seconds (held while focus or the pointer
 * rests on it), which writes the previous picks back in one write. A
 * newer pick, a card's Reset or leaving the tab lets the Undo go. What a
 * write kept goes to the cards, whose units show it.
 */
export class LookReset {
  private offer: Offer | null = null;
  private busy: "reset" | "undo" | null = null;
  /** A newer pick or a card's Reset came while the reset was on its way. */
  private dropped = false;
  private note: UnitNote | null = null;
  private failed: "reset" | Partial<Look> | null = null;
  private focus: LookResetSnapshot["focus"] = null;
  private focusSeq = 0;
  private readonly listeners = new Set<() => void>();
  private current: LookResetSnapshot;

  constructor(private readonly options: { write: LookSend; kept: (look: Look) => void }) {
    this.current = this.build();
  }

  get snapshot(): LookResetSnapshot { return this.current; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The heading row's action for the look on screen: Undo while it is
   * offered, Reset while a pick differs from the default, else none. */
  slot(shown: Look): "reset" | "undo" | null {
    if (this.offer || this.busy === "undo") return "undo";
    return this.busy === "reset" || differs(shown) ? "reset" : null;
  }

  /** Every pick back to the default, in one write. */
  reset(shown: Look): void {
    if (this.busy || this.slot(shown) !== "reset") return;
    const previous = Object.fromEntries(LOOK_KEYS.filter(key => shown[key] !== lookChoices(key)[0]).map(key => [key, shown[key]])) as Partial<Look>;
    this.dropOffer();
    this.run("reset", defaultLook(), previous);
  }

  /** The previous picks back, in one write. */
  undo(): void {
    const offer = this.offer;
    if (!offer || this.busy) return;
    this.dropOffer();
    this.run("undo", offer.previous, null);
  }

  /** Focus or the pointer rests on Undo (on), or leaves it (off). */
  hold(by: "focus" | "pointer", on: boolean): void {
    const offer = this.offer;
    if (!offer || offer.leaving) return;
    if (on) offer.held.add(by); else offer.held.delete(by);
    if (!on && offer.expired && !offer.held.size) this.fade();
  }

  /** A newer pick or a card's Reset: the Undo goes, and a reset still on
   * its way offers none. */
  drop(): void {
    if (this.busy === "reset") this.dropped = true;
    if (!this.offer) return;
    this.dropOffer();
    this.emit();
  }

  /** The tab is left: the Undo goes, and a reset still on its way offers
   * none. Nothing else ends, so a tab mounted again carries on. */
  leave(): void {
    this.dropped = true;
    this.dropOffer();
    this.emit();
  }

  retry(shown: Look): void {
    const failed = this.failed;
    if (!failed || this.busy) return;
    this.failed = null;
    this.note = null;
    if (failed === "reset") this.reset(shown);
    else this.run("undo", failed, null);
    this.emit();
  }

  dismiss(): void {
    this.note = null;
    this.failed = null;
    this.emit();
  }

  private run(how: "reset" | "undo", patch: Partial<Look>, previous: Partial<Look> | null): void {
    this.busy = how;
    this.dropped = false;
    this.note = null;
    this.failed = null;
    this.emit();
    this.options.write(patch).then(kept => {
      this.busy = null;
      this.options.kept(kept);
      if (how === "reset" && previous && !this.dropped) this.offerUndo(previous);
      else if (how === "undo") this.focusTo("reset");
      this.emit();
    }, failure => {
      this.busy = null;
      this.note = { message: failure instanceof Error && failure.message ? failure.message : "This could not be saved.", retry: true };
      this.failed = how === "reset" ? "reset" : patch;
      this.emit();
    });
  }

  private offerUndo(previous: Partial<Look>): void {
    const offer: Offer = { previous, timer: null, held: new Set(), expired: false, leaving: false };
    offer.timer = setTimeout(() => {
      offer.timer = null;
      offer.expired = true;
      if (!offer.held.size) this.fade();
    }, UNDO_MS);
    this.offer = offer;
    this.focusTo("undo");
  }

  private fade(): void {
    const offer = this.offer;
    if (!offer) return;
    offer.leaving = true;
    offer.timer = setTimeout(() => { if (this.offer === offer) { this.offer = null; this.emit(); } }, FADE_MS);
    this.emit();
  }

  private dropOffer(): void {
    if (this.offer?.timer) clearTimeout(this.offer.timer);
    this.offer = null;
  }

  private focusTo(to: "undo" | "reset"): void {
    this.focusSeq += 1;
    this.focus = { to, seq: this.focusSeq };
  }

  private build(): LookResetSnapshot {
    return { busy: this.busy !== null, leaving: !!this.offer?.leaving, note: this.note, focus: this.focus };
  }

  private emit(): void {
    this.current = this.build();
    for (const listener of [...this.listeners]) listener();
  }
}
