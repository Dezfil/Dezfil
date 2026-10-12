import { LIQUID_KINDS, LOOK_ATTRIBUTES } from "@/lib/look";
import { cornerFor, displacementField, shiftFor } from "./lens-maths";

/**
 * The bend of the liquid panels: while Panels is Liquid, every surface of a
 * kind that is on pulls the backdrop in at its edge, where the browser can
 * draw it. The look's stylesheets give each role its fill, blur, light and
 * shadow on the first frame in every browser; this adds what CSS cannot:
 * a displacement map baked for each surface's size, handed to it through
 * its own role's blur, so the surface's rules still decide whether that
 * blur is read (the side menu opened over the page reads the glass
 * strength and never takes it).
 *
 * The surfaces are found through the stylesheets, never a hand list: every
 * rule that draws a role's blur names that role's members, so a new member
 * of a role bends with no change here. Left alone: anything inside an
 * image's default look or a picture of a pick, a pseudo-element (a
 * switch's knob, a slider's thumb: they read their element's blur, which
 * is held at the role's plain one so a bent card around them never
 * reaches them), and a member whose blur is not its role's at the moment.
 *
 * A surface bends at its settled size: while its box changes size, or an
 * animation or transition runs on it or on what carries it, it keeps the
 * plain blur, and it takes the bend again once it has rested. Chromium
 * draws an SVG filter inside a backdrop filter; elsewhere the blur shows
 * alone, and nothing is held or watched for it. On the chrome and the map's
 * buttons the quiet inks step up to the full ink in every browser, and
 * where the bend is not drawn that is all it writes. Stopped, it takes back every property it set
 * and the filters it made, and touches nothing else.
 */

/** The roles a kind makes liquid, the word the root names the kind by, and
 * whether its quiet inks step up. The stage is the map's own frame: it has
 * no ground to bend. */
const ROLE_OF_KIND: Readonly<Record<string, { role: string; ink: boolean }>> = {
  chrome: { role: "glass-chrome", ink: true },
  panels: { role: "glass-panel", ink: false },
  map: { role: "overlay-panel", ink: false },
  buttons: { role: "overlay-control", ink: true },
  cards: { role: "page-card", ink: false },
  inner: { role: "inner-card", ink: false },
  menus: { role: "menu", ink: false },
  dialogs: { role: "dialog", ink: false },
};
export interface LensRole { readonly role: string; readonly word: string; readonly ink: boolean }
export const LENS_ROLES: readonly LensRole[] = LIQUID_KINDS.map(([, word]) => ({ word, ...ROLE_OF_KIND[word] }));

/** Where the shipped look holds whatever the root's look is: an image's
 * default scope and the pictures of the picks. */
export const LEFT_ALONE = ["[data-look-default]", "[data-picture-color]", "[data-picture-contrast]", "[data-picture-corners]", "[data-picture-panels]"];

/** The quiet inks on the chrome and the map's buttons, stepped up. */
export const INK_STEP: Readonly<Record<string, string>> = {
  "--fg-muted": "var(--fg)",
  "--fg-faint": "color-mix(in srgb, var(--fg) 78%, transparent)",
};

/** How long a surface rests before it takes the bend again, in ms. */
export const SETTLE_MS = 150;
/** The smallest side a surface bends at, in px. */
const SMALLEST = 8;
/** How many drawn maps are kept for sizes that come back. */
const MAPS_KEPT = 48;

/* ---- Finding the members through the stylesheets ---- */

/** The part of a CSS rule the search reads; a stylesheet's rules nest in
 * media, supports and layer rules. */
export interface RuleLike {
  readonly selectorText?: string;
  readonly style?: { readonly cssText: string };
  readonly cssRules?: ArrayLike<RuleLike>;
  readonly styleSheet?: SheetLike | null;
}
export interface SheetLike { readonly cssRules: ArrayLike<RuleLike> }

/** Per role: the selectors of its members, and the selectors of the
 * elements whose pseudo-element is a member; and every attribute a rule's
 * selector reads, so a change to any other attribute (a map's camera
 * written at every step of a pan) is no reason to look again. */
export interface LensIndex {
  readonly members: ReadonlyMap<string, readonly string[]>;
  readonly carriers: ReadonlyMap<string, readonly string[]>;
  readonly attributes: ReadonlySet<string>;
}

/** The attributes read whatever the rules say: a class and an id, those the
 * scopes left alone are named by, and those the browser's own rules key on. */
const ALWAYS_READ = ["class", "id", "hidden", "open", ...LEFT_ALONE.map(scope => scope.slice(1, -1))];
/** The states of an element a selector can read that an attribute sets. */
const STATE_ATTRIBUTES: readonly [RegExp, readonly string[]][] = [
  [/:(?:disabled|enabled)(?![\w-])/, ["disabled"]],
  [/:(?:checked|default)(?![\w-])/, ["checked", "selected"]],
  [/:popover-open(?![\w-])/, ["popover"]],
  [/:(?:required|optional)(?![\w-])/, ["required"]],
  [/:(?:read-only|read-write)(?![\w-])/, ["readonly", "contenteditable"]],
  [/:placeholder-shown(?![\w-])/, ["placeholder", "value"]],
  [/:(?:any-)?link(?![\w-])/, ["href"]],
  [/:dir\(/, ["dir"]],
  [/:lang\(/, ["lang"]],
];
const ATTRIBUTE_SELECTOR = /\[\s*(?:[\w-]*\|)?([\w-]+)/g;

/** Split a selector list at its top-level commas. */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let at = 0; at < list.length; at += 1) {
    const ch = list[at];
    if (quote) { if (ch === quote && list[at - 1] !== "\\") quote = null; continue; }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) { out.push(list.slice(start, at).trim()); start = at + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

const PSEUDO_ELEMENT = /::[\w-]+|:(?:before|after|first-line|first-letter)(?![\w-])/;
const USER_ACTION = /^:(?:hover|active|focus-visible|focus-within|focus)(?![\w-])/;

/** A selector without the pointer's and focus's states at its top level, so
 * a member that reads its role only while hovered or focused is found at
 * rest and carries its role's blur, read only in that state. */
export function atRest(selector: string): string {
  let out = "", depth = 0;
  for (let at = 0; at < selector.length; at += 1) {
    const ch = selector[at];
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && ch === ":") {
      const state = USER_ACTION.exec(selector.slice(at));
      if (state) { at += state[0].length - 1; continue; }
    }
    out += ch;
  }
  return out.trim();
}

function rulesOf(sheet: SheetLike): RuleLike[] {
  try { return Array.from(sheet.cssRules); } catch { return []; }
}

/** Every rule that draws a role's blur, by role: the members, and the
 * carriers of a member pseudo-element. Rules inside media, supports and
 * layer rules count; a sheet that cannot be read (another origin) is
 * passed over. */
export function discoverMembers(sheets: Iterable<SheetLike>): LensIndex {
  const members = new Map<string, Set<string>>(), carriers = new Map<string, Set<string>>();
  const attributes = new Set<string>(ALWAYS_READ);
  const reads = LENS_ROLES.map(({ role }) => ({ role, test: new RegExp(`var\\(\\s*--surface-${role}-blur\\s*[,)]`) }));
  const add = (map: Map<string, Set<string>>, role: string, selector: string) => {
    if (!map.has(role)) map.set(role, new Set());
    map.get(role)!.add(selector);
  };
  const visit = (rule: RuleLike) => {
    if (rule.styleSheet) { for (const inner of rulesOf(rule.styleSheet)) visit(inner); return; }
    if (rule.selectorText === undefined) {
      if (rule.cssRules) for (const inner of Array.from(rule.cssRules)) visit(inner);
      return;
    }
    for (const [, name] of rule.selectorText.matchAll(ATTRIBUTE_SELECTOR)) attributes.add(name.toLowerCase());
    for (const [state, names] of STATE_ATTRIBUTES) if (state.test(rule.selectorText)) for (const name of names) attributes.add(name);
    const text = rule.style?.cssText ?? "";
    const read = reads.find(({ test }) => test.test(text));
    if (!read) return;
    for (const selector of splitSelectors(rule.selectorText)) {
      const pseudo = PSEUDO_ELEMENT.exec(selector);
      if (pseudo) {
        const carrier = atRest(selector.slice(0, pseudo.index));
        if (carrier && !/[\s>+~]$/.test(carrier)) add(carriers, read.role, carrier);
        continue;
      }
      const rest = atRest(selector);
      if (rest) add(members, read.role, rest);
    }
  };
  for (const sheet of sheets) for (const rule of rulesOf(sheet)) visit(rule);
  const frozen = (map: Map<string, Set<string>>) => new Map([...map].map(([role, set]) => [role, [...set]]));
  return { members: frozen(members), carriers: frozen(carriers), attributes };
}

/* ---- The bend ---- */

export interface PanelLensOptions {
  /** Whether the browser draws an SVG filter inside a backdrop filter;
   * found from the engine when left out. */
  readonly bend?: boolean;
  /** A displacement field as an image the filter can load; a canvas by default. */
  readonly encode?: (field: Uint8ClampedArray, width: number, height: number) => string | null;
}

export interface PanelLens {
  /** Look at every surface again: a kind switched, the theme changed. */
  refresh(): void;
  /** Take back everything it set and stop watching. */
  stop(): void;
}

/** Whether this browser bends a backdrop through an SVG filter: Chromium. */
export function canBend(): boolean {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (!/(?:Chrome|Chromium)\/\d+/.test(agent) || /Firefox\//.test(agent)) return false;
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("backdrop-filter", "url(#x)");
}

function canvasEncode(doc: Document) {
  return (field: Uint8ClampedArray, width: number, height: number): string | null => {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    // Kept in memory: reading it back never waits on the screen's own drawing.
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    const image = context.createImageData(width, height);
    image.data.set(field);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  };
}

const SVG = "http://www.w3.org/2000/svg";
const MOTION_STARTS = ["transitionrun", "transitionstart", "animationstart"];
/** The properties whose transition moves or resizes a box; a colour, a
 * shadow or an opacity changing in place leaves the bend where it is. */
const GEOMETRY = /^(?:all|transform|translate|scale|rotate|inset|top|right|bottom|left|(?:min-|max-)?(?:width|height)|margin(?:-\w+)?|padding(?:-\w+)?|flex(?:-\w+)?)$/;
/** An animation or transition that moves its box: every keyframe animation
 * (an entrance), and a transition of a property in the list above. */
const moves = (property: string | undefined) => property === undefined || GEOMETRY.test(property);
const blurToken = (role: string) => `--surface-${role}-blur`;
/** Two values of a filter alike, however the browser spaces and quotes them. */
const same = (a: string, b: string) => a.replace(/[\s"']+/g, "") === b.replace(/[\s"']+/g, "");

interface Tracked {
  role: LensRole;
  /** A pseudo-element's carrier: it holds the plain blur and nothing else. */
  readonly carrier: boolean;
  /** The inline properties this module set, by name. */
  readonly set: Map<string, string>;
  /** The filter it carries, if bent. */
  filter: string | null;
  /** Its size and place when last measured. */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** Waiting to rest before it bends again. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface RootValues { readonly words: ReadonlySet<string>; readonly blur: ReadonlyMap<string, string>; readonly lens: ReadonlyMap<string, number> }

/**
 * Start the bend over a document. It reads the root's kinds, finds the
 * members, and keeps them as the page changes, at most once a frame.
 */
export function startPanelLens(doc: Document = document, options: PanelLensOptions = {}): PanelLens {
  const bend = options.bend ?? canBend();
  const encode = options.encode ?? canvasEncode(doc);
  const root = doc.documentElement;
  const tracked = new Map<Element, Tracked>();
  const filters = new Map<string, Element>();
  let index: LensIndex = { members: new Map(), carriers: new Map(), attributes: new Set() };
  /** The maps already drawn, by size and corner: a surface that comes back
   * to a size it had (a status line as its text changes) takes its map again. */
  const maps = new Map<string, string>();
  let fingerprint: string | null = null;
  let values: RootValues = { words: new Set(), blur: new Map(), lens: new Map() };
  let defs: Element | null = null;
  let resize: ResizeObserver | null = null;
  let frame: number | null = null;
  let full = true;
  const pending = new Set<Node>();
  let stopped = false;

  function readRoot(): RootValues {
    const style = getComputedStyle(root);
    const words = new Set(root.getAttribute("data-look-panels") === "liquid" ? (root.getAttribute("data-look-liquid") ?? "").split(/\s+/).filter(Boolean) : []);
    const blur = new Map<string, string>(), lens = new Map<string, number>();
    for (const { role } of LENS_ROLES) {
      blur.set(role, style.getPropertyValue(blurToken(role)).trim());
      lens.set(role, parseFloat(style.getPropertyValue(`--surface-${role}-lens`)) || 0);
    }
    return { words, blur, lens };
  }

  function sheets(): SheetLike[] {
    const own = Array.from((doc.styleSheets ?? []) as ArrayLike<SheetLike>);
    const adopted = ((doc as { adoptedStyleSheets?: readonly SheetLike[] }).adoptedStyleSheets ?? []);
    return [...own, ...adopted];
  }
  /** What the stylesheets hold, cheaply: a sheet joining, or rules added to one. */
  function stamp(list: SheetLike[]): string {
    return list.map(sheet => { try { return sheet.cssRules.length; } catch { return -1; } }).join(",");
  }

  /* ---- writing and taking back ---- */

  function put(el: HTMLElement, entry: Tracked, name: string, value: string) {
    if (entry.set.get(name) === value) return;
    el.style.setProperty(name, value);
    entry.set.set(name, value);
  }
  function take(el: HTMLElement, entry: Tracked, name: string) {
    if (!entry.set.has(name)) return;
    el.style.removeProperty(name);
    entry.set.delete(name);
  }
  function release(el: Element) {
    const entry = tracked.get(el);
    if (!entry) return;
    for (const name of [...entry.set.keys()]) take(el as HTMLElement, entry, name);
    if (entry.timer) clearTimeout(entry.timer);
    resize?.unobserve(el);
    tracked.delete(el);
    // A style attribute this module alone filled goes with it.
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }

  function filterFor(w: number, h: number, r: number, blur: number, shift: number): string | null {
    const id = `dz-lens-${w}x${h}-r${r}-b${blur}-s${shift}`.replace(/\./g, "_");
    if (filters.has(id)) return id;
    const shape = `${w}x${h}-r${r}`;
    let href = maps.get(shape) ?? null;
    if (href === null) {
      href = encode(displacementField(w, h, r), w, h);
      if (!href) return null;
      maps.set(shape, href);
      if (maps.size > MAPS_KEPT) maps.delete(maps.keys().next().value!);
    }
    if (!defs) {
      const svg = doc.createElementNS(SVG, "svg");
      svg.setAttribute("data-panel-lens", "");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.setAttribute("style", "position:fixed;left:-1px;top:-1px;width:0;height:0;overflow:hidden;pointer-events:none");
      defs = doc.createElementNS(SVG, "defs");
      svg.appendChild(defs);
      doc.body.appendChild(svg);
    }
    const filter = doc.createElementNS(SVG, "filter");
    const attributes: Record<string, string> = {
      id, filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", x: "0", y: "0",
      width: String(w), height: String(h), "color-interpolation-filters": "sRGB",
    };
    for (const [name, value] of Object.entries(attributes)) filter.setAttribute(name, value);
    const primitive = (name: string, attributes: Record<string, string>) => {
      const node = doc.createElementNS(SVG, name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      filter.appendChild(node);
    };
    primitive("feImage", { href, x: "0", y: "0", width: String(w), height: String(h), preserveAspectRatio: "none", result: "map" });
    primitive("feGaussianBlur", { in: "SourceGraphic", stdDeviation: String(blur / 2), edgeMode: "duplicate", result: "soft" });
    primitive("feDisplacementMap", { in: "soft", in2: "map", scale: String(shift), xChannelSelector: "R", yChannelSelector: "G" });
    defs.appendChild(filter);
    filters.set(id, filter);
    return id;
  }
  /** Drop the filters no surface carries any more. */
  function sweepFilters() {
    const used = new Set([...tracked.values()].map(entry => entry.filter).filter(Boolean));
    for (const [id, filter] of filters) if (!used.has(id)) { filter.remove(); filters.delete(id); }
  }

  /* ---- one surface ---- */

  function measure(el: Element) {
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
  }
  /** An animation or transition that moves a box runs on the element or on what carries it. */
  function moving(el: Element): boolean {
    for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
      // A transition names its property; a keyframe animation (an entrance) counts whole.
      const animations = (node.getAnimations?.() ?? []) as (Animation & { transitionProperty?: string })[];
      if (animations.some(animation => animation.playState === "running" && moves(animation.transitionProperty))) return true;
    }
    return false;
  }
  const leftAlone = (el: Element) => LEFT_ALONE.some(scope => el.closest(scope));

  /** Hold the plain blur until the surface has rested, then look again. */
  function unsettle(el: HTMLElement, entry: Tracked) {
    entry.filter = null;
    put(el, entry, blurToken(entry.role.role), values.blur.get(entry.role.role) ?? "");
    if (entry.timer) clearTimeout(entry.timer);
    const at = measure(el);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (stopped || tracked.get(el) !== entry) return;
      const now = measure(el);
      if (moving(el) || now.x !== at.x || now.y !== at.y || now.w !== at.w || now.h !== at.h) unsettle(el, entry);
      else { entry.rect = now; place(el, entry.role, false); sweepFilters(); }
    }, SETTLE_MS);
  }

  /** Give one member, or one carrier of a member pseudo-element, what its kind asks for now. */
  function place(el: Element, role: LensRole, carrier: boolean) {
    const html = el as HTMLElement;
    if (!values.words.has(role.word) || leftAlone(el)) { release(el); return; }
    let entry = tracked.get(el);
    if (entry && (entry.role !== role || entry.carrier !== carrier)) { release(el); entry = undefined; }
    const plain = values.blur.get(role.role) ?? "";
    if (carrier) {
      if (!bend) { release(el); return; }
      entry ??= { role, carrier, set: new Map(), filter: null, rect: null, timer: null };
      tracked.set(el, entry);
      put(html, entry, blurToken(role.role), plain);
      return;
    }
    // Where the bend is not drawn, a member has nothing but the inks to be given.
    if (!bend && !role.ink) { release(el); return; }
    // A member draws its role's blur as it reaches it (the root's, a bent
    // surface's around it, its own); a member whose own rules draw another
    // blur right now is left alone.
    const style = getComputedStyle(el);
    const drawn = style.getPropertyValue("backdrop-filter") || style.getPropertyValue("-webkit-backdrop-filter");
    if (!same(drawn, style.getPropertyValue(blurToken(role.role)))) { release(el); return; }
    if (!entry) {
      entry = { role, carrier, set: new Map(), filter: null, rect: null, timer: null };
      tracked.set(el, entry);
      resize?.observe(el);
    }
    if (role.ink) for (const [name, value] of Object.entries(INK_STEP)) put(html, entry, name, value);
    else for (const name of Object.keys(INK_STEP)) take(html, entry, name);
    if (!bend) return;
    // Still settling: the plain blur holds until it has rested.
    if (entry.timer) return;
    if (moving(el)) { unsettle(html, entry); return; }
    const rect = measure(el);
    entry.rect = rect;
    const lens = values.lens.get(role.role) ?? 0;
    const blur = /^blur\(\s*([\d.]+)px\s*\)$/.exec(plain);
    let filter: string | null = null;
    if (lens > 0 && blur && rect.w >= SMALLEST && rect.h >= SMALLEST) {
      const radius = parseFloat(getComputedStyle(el).getPropertyValue("border-top-left-radius")) || 0;
      filter = filterFor(rect.w, rect.h, cornerFor(radius, rect.w, rect.h), parseFloat(blur[1]), shiftFor(lens, rect.w, rect.h));
    }
    entry.filter = filter;
    put(html, entry, blurToken(role.role), filter ? `url("#${filter}")` : plain);
  }

  /* ---- finding them on the page ---- */

  const each = (scope: ParentNode & Partial<Pick<Element, "matches">>, selector: string, visit: (el: Element) => void) => {
    try {
      if (scope.matches?.(selector)) visit(scope as Element);
      for (const el of Array.from(scope.querySelectorAll(selector))) visit(el);
    } catch { /* a selector this browser does not take */ }
  };
  /** Place one element by the first role whose member or carrier it is now; one tracked
   * that no longer matches is looked at again in its old role. */
  function placeOne(el: Element) {
    const matches = (selector: string) => { try { return el.matches(selector); } catch { return false; } };
    for (const role of LENS_ROLES) {
      if ((index.members.get(role.role) ?? []).some(matches)) { place(el, role, false); return; }
      if ((index.carriers.get(role.role) ?? []).some(matches)) { place(el, role, true); return; }
    }
    const entry = tracked.get(el);
    if (entry) place(el, entry.role, entry.carrier);
  }
  /** Place every member and carrier at or under a node; let go of the tracked ones there that no longer match. */
  function sweep(scope: ParentNode & Partial<Pick<Element, "matches">>) {
    const seen = new Set<Element>();
    for (const role of LENS_ROLES) {
      for (const selector of index.members.get(role.role) ?? []) each(scope, selector, el => {
        if (seen.has(el)) return;
        seen.add(el);
        place(el, role, false);
      });
      for (const selector of index.carriers.get(role.role) ?? []) each(scope, selector, el => {
        if (seen.has(el)) return;
        seen.add(el);
        place(el, role, true);
      });
    }
    for (const el of [...tracked.keys()]) {
      if (seen.has(el)) continue;
      if (!el.isConnected || scope === doc || (scope as Node).contains(el)) release(el);
    }
  }

  function run() {
    frame = null;
    if (stopped) return;
    const list = sheets();
    const now = stamp(list);
    if (now !== fingerprint) { fingerprint = now; index = discoverMembers(list); full = true; }
    if (full) {
      full = false;
      pending.clear();
      values = readRoot();
      sweep(doc);
    } else {
      const nodes = [...pending];
      pending.clear();
      const around = new Set<Element>();
      for (const node of nodes) {
        if (!node.isConnected) continue;
        sweep(node as Element);
        // A surface around the node may read another blur now (a state that
        // keys on what it holds, focus inside it), whether it is held now or
        // was let go while that state lasted.
        for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
          if (around.has(el)) break;
          around.add(el);
          placeOne(el);
        }
      }
      for (const el of [...tracked.keys()]) if (!el.isConnected) release(el);
    }
    sweepFilters();
  }
  function schedule() {
    if (frame === null && !stopped) frame = requestAnimationFrame(run);
  }

  /* ---- watching ---- */

  const ours = (node: Node) => defs !== null && (defs.parentNode as Node | null)?.contains(node) === true;
  const mutations = new MutationObserver(records => {
    let any = false;
    for (const record of records) {
      if (ours(record.target)) continue;
      if (record.type === "attributes") {
        // The lens's own writes, and an attribute no rule reads: nothing to look at again.
        if (record.attributeName === "style" || !index.attributes.has(record.attributeName ?? "")) continue;
        pending.add(record.target);
        any = true;
      } else {
        for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1 && !ours(node)) { pending.add(node); any = true; }
        if (record.removedNodes.length) any = true;
      }
    }
    if (any) schedule();
  });
  mutations.observe(doc.body, { childList: true, subtree: true, attributes: true });
  const sheetsJoin = new MutationObserver(() => { full = true; schedule(); });
  sheetsJoin.observe(doc.head, { childList: true });
  const loaded = (event: Event) => {
    if ((event.target as Element | null)?.tagName === "LINK") { full = true; schedule(); }
  };
  doc.addEventListener("load", loaded, true);
  const focused = (event: Event) => {
    const target = event.target as Node | null;
    if (target && !stopped) { pending.add(target); schedule(); }
  };
  doc.addEventListener("focusin", focused, true);
  doc.addEventListener("focusout", focused, true);
  const moved = (event: Event) => {
    const target = event.target as Node | null;
    if (!target || stopped || !moves((event as TransitionEvent).propertyName)) return;
    for (const [el, entry] of tracked) {
      if (!entry.carrier && (el === target || target.contains(el))) unsettle(el as HTMLElement, entry);
    }
  };
  // Motion and size only matter to a bend: where none is drawn they are not watched.
  if (bend) for (const type of MOTION_STARTS) doc.addEventListener(type, moved, true);
  resize = bend && typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
    for (const { target } of entries) {
      const entry = tracked.get(target);
      if (!entry || entry.carrier || !entry.rect) continue;
      const now = measure(target);
      if (now.w !== entry.rect.w || now.h !== entry.rect.h) unsettle(target as HTMLElement, entry);
    }
  }) : null;

  run();

  return {
    refresh() { full = true; schedule(); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      mutations.disconnect();
      sheetsJoin.disconnect();
      resize?.disconnect();
      doc.removeEventListener("load", loaded, true);
      doc.removeEventListener("focusin", focused, true);
      doc.removeEventListener("focusout", focused, true);
      for (const type of MOTION_STARTS) doc.removeEventListener(type, moved, true);
      for (const el of [...tracked.keys()]) release(el);
      for (const filter of filters.values()) filter.remove();
      filters.clear();
      (defs?.parentNode as Element | null)?.remove();
      defs = null;
    },
  };
}

/**
 * Keep the bend in step with the root's look: started while Panels is
 * Liquid with a kind on, looked at again when a kind or the theme changes,
 * stopped otherwise. Returns what stops it for good.
 */
export function watchPanelLens(doc: Document = document, options: PanelLensOptions = {}): () => void {
  const root = doc.documentElement;
  let lens: PanelLens | null = null;
  const sync = () => {
    const on = root.getAttribute("data-look-panels") === "liquid" && Boolean(root.getAttribute("data-look-liquid")?.trim());
    if (on && lens) lens.refresh();
    else if (on) lens = startPanelLens(doc, options);
    else if (lens) { lens.stop(); lens = null; }
  };
  const observer = new MutationObserver(sync);
  // The look's picks and the theme: a kind, a corner or a tone the bend reads.
  observer.observe(root, { attributes: true, attributeFilter: [...LOOK_ATTRIBUTES, "data-theme"] });
  sync();
  return () => { observer.disconnect(); lens?.stop(); lens = null; };
}
