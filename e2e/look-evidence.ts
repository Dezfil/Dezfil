// Evidence for where the person's look lives: on the served document's
// <html> start tag, in markup that styles the page without any script,
// and on the root from the first painted frame. The checks return the
// problems they found rather than asserting, so a journey can hold the
// same check green over the product and red over a deliberately broken
// document.
import type { APIRequestContext, Page } from "@playwright/test";

/** The root attributes a look is stamped as: `data-look-<pick>` for each
 * pick that differs from Dezfil's default. */
export type LookAttributes = Record<string, string>;

/** Patch one account's look through the documented own-settings write. */
export async function setLook(api: APIRequestContext, look: Record<string, string>): Promise<void> {
  const response = await api.patch("/api/settings", { data: { look } });
  if (response.status() !== 200) throw new Error(`look write refused: ${response.status()} ${await response.text()}`);
}

/** Every look attribute of a start tag, in name order. */
function lookOfTag(tag: string): LookAttributes {
  const out: LookAttributes = {};
  for (const match of tag.matchAll(/\s(data-look-[a-z]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

/** The look a served document carries on its `<html>` start tag, read
 * with every script removed first: what a browser that ran no script at
 * all would style the page with. */
export function servedLook(document: string): LookAttributes {
  const markup = document.replace(SCRIPT, "");
  const tag = /<html\b[^>]*>/i.exec(markup);
  if (!tag) throw new Error("the document has no <html> start tag");
  return lookOfTag(tag[0]);
}

/** Code that writes a look onto the root: a `data-look-*` attribute set by
 * script, or a look key written through the root's dataset. */
const APPLIES_LOOK = /setAttribute\(\s*["']data-look-|dataset\.look[A-Z]|dataset\[\s*["']look/;

/**
 * The problems with a served document as the carrier of a look. Green is:
 * the `<html>` start tag outside every script carries exactly `expected`;
 * no script contains code that applies a look to the root; and any script
 * that mentions a look attribute at all is the framework's payload chunk
 * (the server-rendered tree handed to the client as data, which also
 * holds the root element's props), never code that runs against the root.
 */
export function servedLookProblems(document: string, expected: LookAttributes): string[] {
  const problems: string[] = [];
  const carried = servedLook(document);
  if (JSON.stringify(carried) !== JSON.stringify(sorted(expected)))
    problems.push(`the <html> start tag carries ${JSON.stringify(carried)}, not ${JSON.stringify(sorted(expected))}`);
  for (const [, body] of document.matchAll(SCRIPT)) {
    if (APPLIES_LOOK.test(body)) problems.push(`a script applies a look to the root: ${excerpt(body)}`);
    else if (body.includes("data-look-") && !/^\s*self\.__next_f\.push\(/.test(body))
      problems.push(`a script other than the payload carries a look: ${excerpt(body)}`);
  }
  return problems;
}

function sorted(look: LookAttributes): LookAttributes {
  return Object.fromEntries(Object.entries(look).sort(([a], [b]) => a.localeCompare(b)));
}

function excerpt(body: string): string {
  const at = Math.max(0, body.indexOf("data-look-") - 60);
  return body.slice(at, at + 160).replace(/\s+/g, " ");
}

/** A served document with the look taken off its `<html>` start tag. */
export function stripLook(document: string): string {
  return document.replace(/<html\b[^>]*>/i, (tag) => tag.replace(/\s+data-look-[a-z]+="[^"]*"/g, ""));
}

/** A served document whose look arrives late: taken off the `<html>` start
 * tag and applied to the root by a script once the page has loaded. */
export function delayLook(document: string, look: LookAttributes): string {
  const apply = Object.entries(look)
    .map(([name, value]) => `r.setAttribute(${JSON.stringify(name)},${JSON.stringify(value)});`)
    .join("");
  const late = `<script>addEventListener("load",function(){var r=document.documentElement;${apply}});</script>`;
  return stripLook(document).replace(/<head\b[^>]*>/i, (head) => head + late);
}

/** What the recorder saw. `creation` is the root as the parser created it,
 * before any of the page's own scripts could change it; `frame` is the
 * root at the first animation frame, which runs before the first paint. */
export interface FrameEvidence {
  /** At the init script: whether the root already existed. */
  init: { t: number; rootExisted: boolean; readyState: string };
  creation: {
    t: number;
    look: LookAttributes;
    /** How the root's creation was seen: at once, or by observing it. */
    via: "existing" | "observer";
    /** Look attribute writes undone to get back to the created root:
     * the writes that happened between creation and the observer's
     * delivery. */
    undone: number;
    /** Whether the framework's first inline script had run by then. */
    pageScriptRan: boolean;
  } | null;
  frame: { t: number; look: LookAttributes; paintsBefore: string[] } | null;
  /** Paint timing, read once the page has loaded. */
  paints?: { name: string; startTime: number }[];
}

type RecorderWindow = Window & { __lookFrames?: FrameEvidence };

/**
 * The recorder, installed as an init script: it runs when the document is
 * created and before any of its scripts. If the root already exists it is
 * read at once; otherwise the document is observed for the root's
 * insertion, and every attribute write on it delivered in the same batch
 * is undone from the record (by its old value), so the record is the root
 * exactly as the parser created it from the served markup, whenever the
 * observer's delivery runs. The first animation frame is read too, with
 * the paint entries that existed at that moment.
 */
export async function installFrameRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const read = (el: Element): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) if (attr.name.startsWith("data-look-")) out[attr.name] = attr.value;
      return out;
    };
    const ordered = (look: Record<string, string>) =>
      Object.fromEntries(Object.entries(look).sort(([a], [b]) => a.localeCompare(b)));
    const record: FrameEvidence = {
      init: { t: performance.now(), rootExisted: document.documentElement !== null, readyState: document.readyState },
      creation: null,
      frame: null,
    };
    (window as RecorderWindow).__lookFrames = record;
    const pageScriptRan = () => typeof (self as unknown as { __next_f?: unknown }).__next_f !== "undefined";
    if (document.documentElement) {
      record.creation = { t: performance.now(), look: ordered(read(document.documentElement)), via: "existing", undone: 0, pageScriptRan: pageScriptRan() };
    } else {
      const observer = new MutationObserver((records) => {
        let at = -1;
        let root: Element | null = null;
        records.forEach((r, i) => {
          if (at >= 0 || r.type !== "childList") return;
          for (const node of Array.from(r.addedNodes)) {
            if (node.nodeType === 1 && (node as Element).localName === "html" && node.parentNode === document) {
              at = i;
              root = node as Element;
            }
          }
        });
        if (!root) return;
        const created = read(root);
        let undone = 0;
        for (let i = records.length - 1; i > at; i -= 1) {
          const r = records[i];
          if (r.type !== "attributes" || r.target !== root || !r.attributeName?.startsWith("data-look-")) continue;
          undone += 1;
          if (r.oldValue === null) delete created[r.attributeName];
          else created[r.attributeName] = r.oldValue;
        }
        record.creation = { t: performance.now(), look: ordered(created), via: "observer", undone, pageScriptRan: pageScriptRan() };
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeOldValue: true });
    }
    requestAnimationFrame(() => {
      record.frame = {
        t: performance.now(),
        look: ordered(document.documentElement ? read(document.documentElement) : {}),
        paintsBefore: performance.getEntriesByType("paint").map((p) => p.name),
      };
    });
  });
}

/** The recorder's evidence for the page's current document, once its first
 * animation frame has run, with the paint entries as they stand. */
export async function frameEvidence(page: Page): Promise<FrameEvidence> {
  await page.waitForFunction(() => (window as RecorderWindow).__lookFrames?.frame != null, undefined, { timeout: 15_000 });
  return page.evaluate(() => ({
    ...(window as RecorderWindow).__lookFrames!,
    paints: performance.getEntriesByType("paint").map((p) => ({ name: p.name, startTime: p.startTime })),
  }));
}

/** The problems with the evidence as proof that the root carried `expected`
 * from the first painted frame: the created root and the root at the first
 * animation frame both carry exactly the look, the frame was read before
 * anything had painted, and the creation was seen no later than it. */
export function frameProblems(evidence: FrameEvidence, expected: LookAttributes): string[] {
  const want = JSON.stringify(sorted(expected));
  const problems: string[] = [];
  if (!evidence.creation) problems.push("the root's creation was never recorded");
  else if (JSON.stringify(evidence.creation.look) !== want)
    problems.push(`the created root carried ${JSON.stringify(evidence.creation.look)}, not ${want}`);
  if (!evidence.frame) problems.push("the first animation frame was never recorded");
  else {
    if (JSON.stringify(evidence.frame.look) !== want)
      problems.push(`the root at the first animation frame carried ${JSON.stringify(evidence.frame.look)}, not ${want}`);
    if (evidence.frame.paintsBefore.length > 0)
      problems.push(`the first animation frame ran after a paint (${evidence.frame.paintsBefore.join(", ")})`);
  }
  if (evidence.creation && evidence.frame && evidence.creation.t > evidence.frame.t)
    problems.push("the root's creation was recorded after the first animation frame");
  return problems;
}

/** The look attributes on the live root, in name order. */
export function rootLook(page: Page): Promise<LookAttributes> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const attr of Array.from(document.documentElement.attributes)) if (attr.name.startsWith("data-look-")) out[attr.name] = attr.value;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  });
}

/** The evidence in one line for the run's log. */
export function describeEvidence(label: string, evidence: FrameEvidence): string {
  const firstPaint = evidence.paints?.find((p) => p.name === "first-paint")?.startTime;
  return `[first-frame] ${label}: init ${evidence.init.t.toFixed(1)} ms (root existed: ${evidence.init.rootExisted}), ` +
    `creation ${evidence.creation ? `${evidence.creation.t.toFixed(1)} ms via ${evidence.creation.via}, undone ${evidence.creation.undone}, page script ran: ${evidence.creation.pageScriptRan}, look ${JSON.stringify(evidence.creation.look)}` : "never"}, ` +
    `first frame ${evidence.frame ? `${evidence.frame.t.toFixed(1)} ms, paints before: ${evidence.frame.paintsBefore.length}, look ${JSON.stringify(evidence.frame.look)}` : "never"}, ` +
    `first paint ${firstPaint === undefined ? "none" : `${firstPaint.toFixed(1)} ms`}`;
}
