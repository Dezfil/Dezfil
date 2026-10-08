/**
 * A settings card's save unit: what saves when, and what the card shows
 * about it. Framework-free, so every rule is held by unit tests and the
 * card component stays a thin drawing over the snapshot.
 *
 * - A choice, and a switch, is kept at once. A number is kept at once
 *   when stepped, and only the value the steps settle on is sent; a typed
 *   number is kept on Enter or on leaving the field; numbers set together
 *   from elsewhere (a place picked on a map) are kept in one write.
 *   Typed text waits for the card's Save, which writes the changed keys
 *   in one request, and Save and Cancel show only while that text
 *   differs from what was saved. A choice that cannot be kept alone (a
 *   list chosen with nothing in it yet) is held: it shows, and waits for
 *   the Save with the text, until another choice is made or Cancel.
 * - Nothing is marked Saved before the server accepted the write, and the
 *   kept value is the one the response reports. Saved shows only by the
 *   value accepted, never by a newer one, and goes at the next change.
 *   Fields that share one row share its Saved: a change in any of them, or
 *   a red line under any of them, takes the row's Saved away, and it shows
 *   again only when a write of the row is accepted while none of them is
 *   refused, typed and not yet kept, or on its way.
 * - A number out of range is refused before any request, and so is a
 *   number with decimals where the setting takes whole numbers, and typed
 *   text the card's own check refuses on Save. A refusal that
 *   names a row draws the red line under it with the refusal's words and
 *   keeps nothing; any other refusal is the card's error note, with Try
 *   again where trying again can help.
 * - Reset to defaults is offered while a kept value differs from its
 *   default; it puts every control back to its default in one request,
 *   then offers Undo for a few seconds (held while focus or the pointer
 *   is on it), which writes the previous values back in one request.
 * - A setting pinned by the server's environment joins none of this.
 */

/** Rapid steps settle for this long before the settled value is sent. */
export const SETTLE_MS = 300;
/** How long a row's Saved mark holds. */
export const SAVED_HOLD_MS = 2200;
/** How long Undo is offered after a Reset. */
export const UNDO_MS = 6000;
/** How long Undo takes to fade once it lets go. */
export const FADE_MS = 400;

export type Value = string | number | boolean | null;

export interface UnitControl {
  /** The key the write takes. */
  readonly key: string;
  /** A switch is true or false, kept at once as a choice is. */
  readonly kind: "choice" | "switch" | "number" | "text";
  /** A number's accepted range. */
  readonly min?: number;
  readonly max?: number;
  /** A number that takes decimals, kept as given. Every other number is a
   * whole number. */
  readonly decimal?: boolean;
  /** The row it shares one Saved mark with, where a row holds several. */
  readonly row?: string;
  /** Pinned by the server's environment, or fixed: never edited, saved, reset or held. */
  readonly locked?: boolean;
  /** What Reset to defaults returns it to. A control without one is not reset. */
  readonly defaultValue?: Value;
}

/** A write the server answered with a refusal, with its code. */
export class WriteRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "WriteRefusal";
  }
}

export interface UnitNote { readonly message: string; readonly retry: boolean }
export interface UnitFocus { readonly to: "field" | "undo" | "reset" | "heading"; readonly key?: string; readonly seq: number }

export interface UnitSnapshot {
  /** What each control shows: a number and a text as the field's text. */
  readonly values: Readonly<Record<string, Value>>;
  /** What the server last reported as kept. */
  readonly kept: Readonly<Record<string, Value>>;
  /** The red line under each row that has one. */
  readonly errors: Readonly<Record<string, string>>;
  /** The rows showing Saved. */
  readonly saved: readonly string[];
  readonly note: UnitNote | null;
  /** A Save is in flight. */
  readonly busy: boolean;
  /** Save and Cancel show. */
  readonly saveLine: boolean;
  /** Leaving the tab would lose typed text. */
  readonly dirty: boolean;
  /** The quiet action at the head's right. */
  readonly slot: "reset" | "undo" | null;
  readonly undoLeaving: boolean;
  /** Where focus should go, once per seq. */
  readonly focus: UnitFocus | null;
}

type Patch = Record<string, Value>;
type Write = (patch: Patch) => Promise<Record<string, Value>>;
interface Operation { readonly how: "keep" | "save" | "reset" | "undo"; patch: Patch; readonly previous?: Patch }
interface UndoOffer { readonly previous: Patch; timer: ReturnType<typeof setTimeout> | null; held: Set<"focus" | "pointer">; expired: boolean; leaving: boolean }

/** The rows a refusal names among `keys`, each with its own words: the
 * reason after "key: ", or the whole sentence when it names the key
 * otherwise (a rule between two settings). */
export function rowRefusals(message: string, keys: readonly string[]): Record<string, string> {
  const named = new Set(keys), out: Record<string, string> = {};
  const marks = [...message.matchAll(/(?:^|\s)([A-Za-z][\w.]*): /g)].filter(mark => named.has(mark[1]));
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : message.length;
    out[mark[1]] = message.slice(mark.index + mark[0].length, end).trim();
  });
  if (marks.length) return out;
  for (const key of keys) {
    const word = new RegExp(`(^|[^\\w.])${key.replace(/[.]/g, "\\.")}([^\\w]|$)`);
    if (word.test(message)) out[key] = message;
  }
  return out;
}

/** A number's own check, before any request: a decimal only where the
 * control takes one. */
export function numberProblem(text: string, control: Pick<UnitControl, "min" | "max" | "decimal">): string | null {
  const trimmed = text.trim(), value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value)) return "Enter a number.";
  const { min, max } = control;
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    return min !== undefined && max !== undefined ? `Enter a number from ${min} to ${max}.`
      : min !== undefined ? `Enter a number of ${min} or more.` : `Enter a number of ${max} or less.`;
  }
  return control.decimal || Number.isInteger(value) ? null : "Enter a whole number.";
}

/** A choice or a switch shows its value as it is; a number and a text as
 * the field's text. */
const asIs = (control: UnitControl) => control.kind === "choice" || control.kind === "switch";

function display(control: UnitControl, value: Value): Value {
  return asIs(control) ? value : value === null || value === undefined ? "" : String(value);
}

function same(control: UnitControl, a: Value, b: Value): boolean {
  if (asIs(control)) return a === b || String(a) === String(b);
  const left = String(a ?? "").trim(), right = String(b ?? "").trim();
  if (control.kind === "number" && left !== "" && right !== "" && Number.isFinite(Number(left)) && Number.isFinite(Number(right))) {
    return Number(left) === Number(right);
  }
  return control.kind === "number" ? left === right : String(a ?? "") === String(b ?? "");
}

/** A card's own check of its typed text before Save: the red line for
 * each field it refuses, by key. */
export type UnitCheck = (values: Readonly<Record<string, Value>>) => Record<string, string> | null;

export class SaveUnit {
  readonly title: string;
  private readonly controls = new Map<string, UnitControl>();
  private readonly write: Write;
  private readonly check: UnitCheck | null;
  private readonly refusalRows: boolean;
  private kept: Record<string, Value> = {};
  private values: Record<string, Value> = {};
  private errors: Record<string, string> = {};
  private readonly saved = new Map<string, ReturnType<typeof setTimeout>>();
  private note: UnitNote | null = null;
  private busy = false;
  private offer: UndoOffer | null = null;
  private focus: UnitFocus | null = null;
  private focusSeq = 0;
  private lastTyped: string | null = null;
  /** Choices held for the card's Save. */
  private readonly held = new Set<string>();
  private readonly settling = new Set<string>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private flight: Operation | null = null;
  private readonly queue: Operation[] = [];
  private failed: Operation | null = null;
  /** Rows another writer's write went past: they show what it reports. */
  private readonly superseded = new Set<string>();
  /** The write that was on its way when another writer's write went past
   * this card's rows: that write lands after it, so what this one sends is
   * not what the server will hold. */
  private overtaken: Operation | null = null;
  private readonly listeners = new Set<() => void>();
  private current!: UnitSnapshot;

  constructor(options: {
    title: string; controls: readonly UnitControl[]; kept: Record<string, Value>; write: Write;
    /** Checked on Save before any request. */
    validate?: UnitCheck;
    /** False when the server's refusals are written for the whole card (an
     * account's), so none is read as naming a row: each is the card's note. */
    refusalRows?: boolean;
  }) {
    this.title = options.title;
    this.write = options.write;
    this.check = options.validate ?? null;
    this.refusalRows = options.refusalRows ?? true;
    for (const control of options.controls) {
      this.controls.set(control.key, control);
      const value = options.kept[control.key] ?? null;
      this.kept[control.key] = value;
      this.values[control.key] = display(control, value);
    }
    this.current = this.build();
  }

  get snapshot(): UnitSnapshot { return this.current; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A person changes what a field shows: typed text, or a typed number
   * not yet kept. Nothing is sent. */
  edit(key: string, value: Value): void {
    const control = this.editable(key);
    if (!control) return;
    this.changed(control, value);
    if (control.kind === "text") this.lastTyped = key;
    if (control.kind === "number") this.settling.delete(key);
    this.emit();
  }

  /** A choice, or a switch turned on or off: kept at once. */
  choose(key: string, value: Value): void {
    const control = this.editable(key);
    if (!control) return;
    this.held.delete(key);
    this.changed(control, value);
    if (this.differs(control, value)) this.enqueue({ how: "keep", patch: { [key]: value } });
    this.emit();
  }

  /** A choice that cannot be kept alone: it shows, nothing is sent, and it
   * goes with the card's Save. Choosing again lets it go. */
  hold(key: string, value: Value): void {
    const control = this.editable(key);
    if (!control || control.kind !== "choice") return;
    this.changed(control, value);
    this.held.add(key);
    this.emit();
  }

  /** A number stepped (arrows, the spin buttons, the wheel): kept at once,
   * the settled value only. */
  step(key: string, text: string): void {
    const control = this.editable(key);
    if (!control || control.kind !== "number") return;
    this.changed(control, text);
    const problem = numberProblem(text, control);
    if (problem) { this.refuseRow(key, problem); this.settling.delete(key); }
    else {
      this.settling.add(key);
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => { this.settleTimer = null; this.settle(); }, SETTLE_MS);
    }
    this.emit();
  }

  /** A typed number, on Enter or on leaving the field. */
  commit(key: string): void {
    const control = this.editable(key);
    if (!control || control.kind !== "number") return;
    this.settling.delete(key);
    const text = String(this.values[key] ?? "");
    const problem = numberProblem(text, control);
    if (problem) this.refuseRow(key, problem);
    else if (this.differs(control, text)) this.enqueue({ how: "keep", patch: { [key]: Number(text.trim()) } });
    this.emit();
  }

  /** Numbers set together from elsewhere (a place picked on a map): each
   * field shows its text, and every one that passes its own check and
   * differs from what the writes on their way end at is kept in one write.
   * One its check refuses takes the red line; a step still settling on any
   * of them is dropped, so it never lands after. */
  keepTogether(texts: Readonly<Record<string, string>>): void {
    const patch: Patch = {};
    for (const [key, text] of Object.entries(texts)) {
      const control = this.editable(key);
      if (!control || control.kind !== "number") continue;
      this.settling.delete(key);
      this.changed(control, text);
      const problem = numberProblem(text, control);
      if (problem) this.refuseRow(key, problem);
      else if (this.differs(control, text)) patch[key] = Number(text.trim());
    }
    if (this.settleTimer && !this.settling.size) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    if (Object.keys(patch).length) this.enqueue({ how: "keep", patch });
    this.emit();
  }

  /** The card's Save: every changed text in one request. */
  save(): void {
    if (this.busy) return;
    const patch: Patch = {};
    for (const control of this.controls.values()) {
      if (this.waitsForSave(control) && !same(control, this.values[control.key], this.kept[control.key])) {
        patch[control.key] = this.values[control.key];
      }
    }
    if (!Object.keys(patch).length) return;
    const problems = Object.entries(this.check?.(this.values) ?? {}).filter(([key]) => this.controls.has(key));
    if (problems.length) {
      for (const [key, problem] of problems) this.refuseRow(key, problem);
      this.focusTo("field", problems[0][0]);
      this.emit();
      return;
    }
    this.busy = true;
    this.note = null;
    this.enqueue({ how: "save", patch });
    this.emit();
  }

  /** Every control back to what was saved. */
  cancel(): void {
    this.held.clear();
    for (const control of this.controls.values()) {
      if (!control.locked) this.values[control.key] = display(control, this.target(control.key) ?? this.kept[control.key]);
    }
    this.settling.clear();
    this.errors = {};
    this.note = null;
    this.focusTo(this.lastTyped ? "field" : "heading", this.lastTyped ?? undefined);
    this.emit();
  }

  /** Reset to defaults: every editable, unlocked control of the card, in
   * one write, the response then setting what each shows (typed text in a
   * field already saved at its default included). Undo writes back only
   * what differed from the defaults: the rest was at its default already.
   * A stepped number still settling is dropped, so it never lands after. */
  reset(): void {
    if (this.slot() !== "reset") return;
    const patch: Patch = {}, previous: Patch = {};
    for (const control of this.resettable()) {
      patch[control.key] = null;
      if (!same(control, this.kept[control.key], control.defaultValue ?? null)) previous[control.key] = this.kept[control.key];
      this.settling.delete(control.key);
    }
    if (this.settleTimer && !this.settling.size) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    // A held choice is reset with the rest: what the response reports shows.
    this.held.clear();
    this.errors = {};
    this.note = null;
    this.enqueue({ how: "reset", patch, previous });
    this.emit();
  }

  /** Undo the Reset: the previous values, in one write. */
  undo(): void {
    const offer = this.offer;
    if (!offer) return;
    this.dropUndo();
    this.enqueue({ how: "undo", patch: { ...offer.previous } });
    this.emit();
  }

  /** Focus or the pointer rests on Undo (on), or leaves it (off). */
  holdUndo(by: "focus" | "pointer", on: boolean): void {
    const offer = this.offer;
    if (!offer || offer.leaving) return;
    if (on) offer.held.add(by); else offer.held.delete(by);
    if (!on && offer.expired && !offer.held.size) this.fadeUndo();
  }

  /** Try the refused write again. */
  retry(): void {
    const failed = this.failed;
    if (!failed) return;
    this.failed = null;
    this.note = null;
    if (failed.how === "save") { this.save(); return; }
    if (failed.how === "keep") for (const [key, value] of Object.entries(failed.patch)) this.values[key] = display(this.controls.get(key)!, value);
    this.enqueue({ ...failed, patch: { ...failed.patch } });
    this.emit();
  }

  dismiss(): void {
    this.note = null;
    this.failed = null;
    this.emit();
  }

  /** What another writer over the same values reports kept (a tab-wide
   * reset): taken as a response is. A row still showing what was kept, or
   * one under a refusal, shows the new value; a row whose newer change is
   * on its way keeps showing it, and its own write lands it. The card's
   * Undo goes, since what it would write back is gone, and so does the
   * Saved of any row whose value changed. */
  sync(reported: Record<string, Value>): void {
    for (const control of this.controls.values()) {
      const key = control.key;
      if (!(key in reported)) continue;
      const next = reported[key] ?? null;
      const refused = key in this.errors;
      const passed = this.superseded.delete(key) && !this.pending(key);
      if (refused || passed || (same(control, this.values[key], this.kept[key]) && !this.pending(key))) {
        if (!same(control, this.values[key], next)) this.unmarkRow(key);
        this.values[key] = display(control, next);
      }
      if (refused) {
        const rest = { ...this.errors };
        delete rest[key];
        this.errors = rest;
      }
      this.kept[key] = next;
    }
    this.dropUndo();
    this.emit();
  }

  /** Another writer over the same values (a tab-wide reset) is about to
   * send these keys, after the write this card has on its way. Every
   * change to them made before it and not yet sent is dropped, so none
   * lands after it; the rows it went past keep showing their change until
   * it answers, then show what it reports (`sync`), or what is kept if it
   * is refused (`release`). */
  supersede(keys: readonly string[]): void {
    const covered = new Set(keys.filter(key => this.controls.has(key)));
    if (!covered.size) return;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const operation = this.queue[index];
      for (const key of Object.keys(operation.patch)) if (covered.has(key)) delete operation.patch[key];
      if (Object.keys(operation.patch).length) continue;
      this.queue.splice(index, 1);
      if (operation.how === "save") this.busy = false;
    }
    for (const key of covered) { this.settling.delete(key); this.superseded.add(key); }
    if (this.flight) this.overtaken = this.flight;
    if (this.settleTimer && !this.settling.size) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    this.emit();
  }

  /** The superseding write was refused: the rows it went past show what is kept. */
  release(keys: readonly string[]): void {
    for (const key of keys) {
      const control = this.controls.get(key);
      if (!control || !this.superseded.delete(key) || this.pending(key)) continue;
      this.values[key] = display(control, this.kept[key]);
    }
    this.emit();
  }

  /** The tab is left: Undo and the Saved marks go; a settling number is sent now. */
  leave(): void {
    this.dropUndo();
    for (const timer of this.saved.values()) clearTimeout(timer);
    this.saved.clear();
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; this.settle(); }
    this.emit();
  }

  /** Typed text, and a held choice, go with the card's Save. */
  private waitsForSave(control: UnitControl): boolean {
    return !control.locked && (control.kind === "text" || this.held.has(control.key));
  }

  private editable(key: string): UnitControl | undefined {
    const control = this.controls.get(key);
    return control && !control.locked ? control : undefined;
  }

  private resettable(): UnitControl[] {
    return [...this.controls.values()].filter(control => !control.locked && control.defaultValue !== undefined);
  }

  /** A person's change: the value shows, its red line goes, and so does
   * its row's Saved (Saved belongs to the values the server accepted);
   * Undo lets go. */
  private changed(control: UnitControl, value: Value): void {
    this.values[control.key] = value;
    if (control.key in this.errors) {
      const rest = { ...this.errors };
      delete rest[control.key];
      this.errors = rest;
    }
    this.unmarkRow(control.key);
    this.dropUndo();
  }

  /** What the server will hold for a key once the writes on their way
   * land, or undefined when that is another writer's to say: a row another
   * writer's write went past, with no change of its own made since. The
   * write that was on its way when that write came does not count, since
   * that write lands after it. */
  private target(key: string): Value | undefined {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const operation = this.queue[index];
      if (key in operation.patch && operation.how !== "reset") return operation.patch[key];
    }
    const flight = this.flight && key in this.flight.patch && this.flight.how !== "reset" ? this.flight : null;
    if (flight && flight !== this.overtaken) return flight.patch[key];
    if (this.superseded.has(key)) return undefined;
    return flight ? flight.patch[key] : this.kept[key];
  }

  /** A change is sent unless the writes on their way already end at it. */
  private differs(control: UnitControl, value: Value): boolean {
    const target = this.target(control.key);
    return target === undefined || !same(control, value, target);
  }

  private settle(): void {
    const patch: Patch = {};
    for (const key of this.settling) {
      const control = this.controls.get(key)!, text = String(this.values[key] ?? "");
      if (!numberProblem(text, control) && this.differs(control, text)) patch[key] = Number(text.trim());
    }
    this.settling.clear();
    if (Object.keys(patch).length) this.enqueue({ how: "keep", patch });
    this.emit();
  }

  private enqueue(operation: Operation): void {
    const last = this.queue[this.queue.length - 1];
    if (operation.how === "keep" && last?.how === "keep") last.patch = { ...last.patch, ...operation.patch };
    else this.queue.push(operation);
    if (!this.flight) void this.next();
  }

  private waiting(key: string): boolean {
    return this.settling.has(key) || this.queue.some(operation => key in operation.patch);
  }

  /** A change to the key is waiting or on its way. */
  private pending(key: string): boolean {
    return this.waiting(key) || (!!this.flight && key in this.flight.patch);
  }

  private async next(): Promise<void> {
    const operation = this.queue.shift();
    if (!operation) return;
    this.flight = operation;
    try {
      const reported = await this.write(operation.patch);
      this.flight = null;
      if (this.overtaken === operation) this.overtaken = null;
      this.accepted(operation, reported);
    } catch (failure) {
      this.flight = null;
      if (this.overtaken === operation) this.overtaken = null;
      this.refused(operation, failure);
    }
    this.emit();
    void this.next();
  }

  private accepted(operation: Operation, reported: Record<string, Value>): void {
    const forced = operation.how === "reset" || operation.how === "undo";
    for (const control of this.controls.values()) {
      const key = control.key;
      if (!(key in reported)) continue;
      const next = reported[key] ?? null;
      const shown = this.values[key];
      if (key in operation.patch) {
        if (forced || (same(control, shown, operation.patch[key]) && !this.waiting(key))) this.values[key] = display(control, next);
      } else if (same(control, shown, this.kept[key]) && !this.waiting(key)) {
        this.values[key] = display(control, next);
      }
      this.kept[key] = next;
    }
    this.note = null;
    this.failed = null;
    if (operation.how === "save") {
      this.busy = false;
      for (const key of Object.keys(operation.patch)) this.held.delete(key);
      if (this.lastTyped) this.focusTo("field", this.lastTyped);
    }
    if (operation.how === "keep" || operation.how === "save") {
      // Saved only by the value this answer accepted, while no newer change
      // is on its way, and none of its row is refused or not yet kept.
      for (const key of Object.keys(operation.patch)) {
        if (this.controls.has(key) && key in reported && this.settled(key)) this.markSaved(key);
      }
    }
    if (operation.how === "reset") this.offerUndo(operation.previous ?? {});
    if (operation.how === "undo") this.focusTo(this.slot() === "reset" ? "reset" : "heading");
  }

  private refused(operation: Operation, failure: unknown): void {
    if (operation.how === "save") this.busy = false;
    const keys = Object.keys(operation.patch);
    if (this.refusalRows && failure instanceof WriteRefusal && failure.code === "invalid_request") {
      const rows = rowRefusals(failure.message, keys);
      if (Object.keys(rows).length) {
        for (const [key, reason] of Object.entries(rows)) this.refuseRow(key, reason);
        return;
      }
    }
    const message = failure instanceof Error && failure.message ? failure.message : "This could not be saved.";
    const retry = !(failure instanceof WriteRefusal) || failure.status >= 500;
    this.note = { message, retry };
    this.failed = operation;
    if (operation.how === "keep") {
      // Nothing was kept: a choice or a number shows what the server holds.
      for (const key of keys) {
        const control = this.controls.get(key)!;
        if (same(control, this.values[key], operation.patch[key]) && !this.waiting(key)) this.values[key] = display(control, this.kept[key]);
      }
    }
  }

  private markSaved(key: string): void {
    const previous = this.saved.get(key);
    if (previous) clearTimeout(previous);
    this.saved.set(key, setTimeout(() => { this.saved.delete(key); this.emit(); }, SAVED_HOLD_MS));
  }

  private unmarkSaved(key: string): void {
    const timer = this.saved.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.saved.delete(key);
  }

  /** The keys sharing a control's Saved: its row's, or its own alone. */
  private rowKeys(key: string): string[] {
    const row = this.controls.get(key)?.row;
    return row === undefined ? [key] : [...this.controls.values()].filter(control => control.row === row).map(control => control.key);
  }

  /** A row's Saved goes, every timer of it with it. */
  private unmarkRow(key: string): void {
    for (const each of this.rowKeys(key)) this.unmarkSaved(each);
  }

  /** The red line under a field: never beside its row's Saved. */
  private refuseRow(key: string, reason: string): void {
    this.errors = { ...this.errors, [key]: reason };
    this.unmarkRow(key);
  }

  /** A row may show Saved: none of it under a red line, waiting to be
   * sent, or showing anything but what is kept. */
  private settled(key: string): boolean {
    return this.rowKeys(key).every(each => !(each in this.errors) && !this.waiting(each) && same(this.controls.get(each)!, this.values[each], this.kept[each]));
  }

  private offerUndo(previous: Patch): void {
    this.dropUndo();
    const offer: UndoOffer = { previous, timer: null, held: new Set(), expired: false, leaving: false };
    offer.timer = setTimeout(() => {
      offer.timer = null;
      offer.expired = true;
      if (!offer.held.size) this.fadeUndo();
    }, UNDO_MS);
    this.offer = offer;
    this.focusTo("undo");
  }

  private fadeUndo(): void {
    const offer = this.offer;
    if (!offer) return;
    offer.leaving = true;
    offer.timer = setTimeout(() => { if (this.offer === offer) { this.offer = null; this.emit(); } }, FADE_MS);
    this.emit();
  }

  private dropUndo(): void {
    if (this.offer?.timer) clearTimeout(this.offer.timer);
    this.offer = null;
  }

  private slot(): "reset" | "undo" | null {
    if (this.offer) return "undo";
    return this.resettable().some(control => !same(control, this.kept[control.key], control.defaultValue ?? null)) ? "reset" : null;
  }

  private focusTo(to: UnitFocus["to"], key?: string): void {
    this.focusSeq += 1;
    this.focus = { to, ...(key ? { key } : {}), seq: this.focusSeq };
  }

  private build(): UnitSnapshot {
    const saveLine = [...this.controls.values()].some(control =>
      this.waitsForSave(control) && !same(control, this.values[control.key], this.kept[control.key]));
    return {
      values: { ...this.values }, kept: { ...this.kept }, errors: { ...this.errors }, saved: [...this.saved.keys()],
      note: this.note, busy: this.busy, saveLine, dirty: saveLine, slot: this.slot(),
      undoLeaving: !!this.offer?.leaving, focus: this.focus,
    };
  }

  private emit(): void {
    this.current = this.build();
    for (const listener of [...this.listeners]) listener();
  }
}
