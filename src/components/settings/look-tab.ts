import { LIQUID_KINDS, LOOK_ATTRIBUTES, LOOK_KEYS, lookAttributes, lookChoices, normalizeLook, type LiquidKind, type Look, type LookKey } from "@/lib/look";
import { FADE_MS, SaveUnit, UNDO_MS, type UnitControl, type UnitNote, type UnitSnapshot, type Value } from "./save-unit";

/**
 * The Appearance tab's own logic, framework-free: its cards and rows, the
 * one writer every look write goes through, what the page shows while
 * picks are on their way, and the tab-wide Reset to Dezfil's default with
 * its Undo. A card's own saving, Reset and Undo are the frame's save unit.
 */

/** The picks the tab draws as a row of pictures, one per choice. */
export const PICTURE_PICKS = ["color", "contrast", "font", "background", "corners", "rail", "panels"] as const satisfies readonly LookKey[];
export type PicturePick = (typeof PICTURE_PICKS)[number];

/** A pick drawn as a row of pictures, one per choice. */
export interface PictureRow {
  readonly kind?: undefined;
  readonly key: PicturePick;
  readonly label: string;
  /** The row's address inside the tab. */
  readonly id: string;
  /** Words the search also finds the row by. */
  readonly keys: string;
}

/** The kinds of surface Liquid reaches, one switch each, in sight only
 * while Liquid is shown. The search finds them through the Panels row. */
export interface KindsRow {
  readonly kind: "kinds";
  readonly label: string;
  readonly id: string;
  readonly kinds: readonly { readonly key: LiquidKind; readonly label: string }[];
}

export type LookRow = PictureRow | KindsRow;

export interface LookCard {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly LookRow[];
}

/** The kinds in the person's words, in the order the root lists them. */
const KIND_LABELS: Readonly<Record<LiquidKind, string>> = {
  liquidChrome: "Header and side menu", liquidPanels: "Side panels", liquidMap: "On the map", liquidButtons: "Map buttons",
  liquidCards: "Page cards", liquidInner: "Cards inside panels", liquidMenus: "Menus and pop-overs", liquidDialogs: "Dialogs",
};
const KINDS = LIQUID_KINDS.map(([key]) => ({ key, label: KIND_LABELS[key] }));

/** The cards, top to bottom: Color leads, as it changes the most. Panels
 * leads the second card, the kinds under it while Liquid is shown, then
 * Background. A card left with one row keeps its place and names only
 * what it holds. */
export const LOOK_CARDS: readonly LookCard[] = [
  { id: "appearance-color", title: "Color and contrast", rows: [
    { key: "color", label: "Color", id: "set-color",
      keys: "colour tint hue accent highlight kelp green harbor blue heather violet purple lavender slate grey gray graphite" },
    { key: "contrast", label: "Contrast", id: "set-contrast", keys: "borders legibility readable muted faint accessibility" },
  ] },
  { id: "appearance-background", title: "Panels and background", rows: [
    { key: "panels", label: "Panels", id: "set-panels",
      keys: `glass frosted liquid paper transparent blur solid ${KINDS.map(kind => kind.label.toLowerCase()).join(" ")}` },
    { kind: "kinds", label: "Liquid panels", id: "set-liquid-panels", kinds: KINDS },
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
  panels: { glass: "Glass", liquid: "Liquid", paper: "Paper" },
  liquidChrome: { on: "On", off: "Off" },
  liquidPanels: { on: "On", off: "Off" },
  liquidMap: { on: "On", off: "Off" },
  liquidButtons: { on: "On", off: "Off" },
  liquidCards: { on: "On", off: "Off" },
  liquidInner: { on: "On", off: "Off" },
  liquidMenus: { on: "On", off: "Off" },
  liquidDialogs: { on: "On", off: "Off" },
};

/** A choice as the tab names it. */
export function choiceLabel(key: LookKey, value: string): string {
  return CHOICE_LABELS[key][value] ?? value;
}

/** A pick's key in a card's save unit: the API's own name for it, so a
 * refusal naming `look.color` lands on the Color row. */
export const unitKey = (key: LookKey) => `look.${key}`;
const pickOf = (key: string) => key.slice("look.".length) as LookKey;

/** The kinds are in sight only while Liquid is shown for Panels. */
export const kindsShown = (panels: unknown) => panels === "liquid";
const KIND_KEYS: ReadonlySet<LookKey> = new Set(LIQUID_KINDS.map(([key]) => key));

/** The picks in sight over a look, the ones a reset pressed over it takes:
 * every pick, and the kinds while Liquid is shown. */
export function shownKeys(look: Look): LookKey[] {
  return LOOK_KEYS.filter(key => !KIND_KEYS.has(key) || kindsShown(look.panels));
}

export type LookSend = (patch: Partial<Look>) => Promise<Look>;

/**
 * Every look write on the tab, one at a time in the order they reach it:
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
 * only, so a Reset writes each pick's default itself. The kinds share one
 * row's Saved and are out of sight while the card's Panels is not Liquid. */
export function lookUnit(card: LookCard, kept: Look, writer: LookWriter): SaveUnit {
  const controls: UnitControl[] = card.rows.flatMap(row => row.kind === "kinds"
    ? row.kinds.map(({ key }) => ({ key: unitKey(key), kind: "choice" as const, defaultValue: lookChoices(key)[0], row: row.id,
      hidden: (shown: Readonly<Record<string, Value>>) => !kindsShown(shown[unitKey("panels")]) }))
    : [{ key: unitKey(row.key), kind: "choice" as const, defaultValue: lookChoices(row.key)[0] }]);
  const keys = controls.map(control => pickOf(control.key));
  return new SaveUnit({
    title: card.title,
    controls,
    kept: Object.fromEntries(keys.map(key => [unitKey(key), kept[key]])),
    write: async patch => {
      const look = await writer.write(Object.fromEntries(Object.entries(patch).map(([key, value]) =>
        [pickOf(key), value ?? lookChoices(pickOf(key))[0]])) as Partial<Look>);
      return unitValues(look, keys);
    },
  });
}

export interface LookTab { readonly units: readonly SaveUnit[]; readonly reset: LookReset }

/**
 * The tab's four cards and its tab-wide reset over the one writer. A card
 * queues its own writes before they reach the writer, so the reset and its
 * Undo join that queue first: every change a card made before them and
 * has not sent yet is superseded, since they write each pick themselves,
 * and nothing made before them lands after them. What they keep goes to
 * the cards; a refusal returns the rows they went past to what is kept.
 */
export function lookTab(kept: Look, send: LookSend): LookTab {
  const writer = new LookWriter(send);
  const units = LOOK_CARDS.map(card => lookUnit(card, kept, writer));
  const reset = new LookReset({
    write: patch => {
      const keys = (Object.keys(patch) as LookKey[]).map(unitKey);
      for (const unit of units) unit.supersede(keys);
      return writer.write(patch).catch((failure: unknown) => {
        for (const unit of units) unit.release(keys);
        throw failure;
      });
    },
    kept: look => { for (const unit of units) unit.sync(unitValues(look)); },
  });
  return { units, reset };
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
 * differs from the default and the kinds' one word list under Liquid,
 * every other look attribute removed. */
export function stampLook(root: Element, look: Look): void {
  const attributes: Record<string, string | undefined> = lookAttributes(look);
  for (const name of LOOK_ATTRIBUTES) {
    const value = attributes[name];
    if (value === undefined) root.removeAttribute(name);
    else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
}

const differs = (look: Look) => shownKeys(look).some(key => look[key] !== lookChoices(key)[0]);

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
 * The tab-wide Reset to Dezfil's default: every pick in sight when it is
 * pressed back in one write (the kinds only while Liquid shows them, so a
 * kind out of sight stays stored), then Undo in its place for six seconds
 * (held while focus or the pointer rests on it), which writes back whole
 * what the reset changed, the kinds it put out of sight included. A newer
 * pick, a card's Reset or leaving the tab lets the Undo go. What a write
 * kept goes to the cards, whose units show it.
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
   * offered, Reset while a pick in sight differs from the default, else none. */
  slot(shown: Look): "reset" | "undo" | null {
    if (this.offer || this.busy === "undo") return "undo";
    return this.busy === "reset" || differs(shown) ? "reset" : null;
  }

  /** Every pick in sight back to the default, in one write. */
  reset(shown: Look): void {
    if (this.busy || this.slot(shown) !== "reset") return;
    const keys = shownKeys(shown);
    const patch = Object.fromEntries(keys.map(key => [key, lookChoices(key)[0]])) as Partial<Look>;
    const previous = Object.fromEntries(keys.filter(key => shown[key] !== lookChoices(key)[0]).map(key => [key, shown[key]])) as Partial<Look>;
    this.dropOffer();
    this.run("reset", patch, previous);
  }

  /** What the reset changed back, whole, in one write. */
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
