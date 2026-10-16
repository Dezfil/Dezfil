import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
vi.mock("next/navigation", () => ({ usePathname: () => "/maps" }));
import { RailModeContext, railModeOf, type RailMode } from "./rail-mode";
import { NavLinks, RailSettingsLink, RailUsersLink } from "./NavLinks";
import { UserBadge } from "./UserBadge";

/**
 * Under Icons only the rail never opens, so each item names itself in a
 * hint beside its icon: every link by its label, the account row by the
 * person's name. Under the other two picks the labels are on screen
 * (open) or one rest away (hover), and no item carries a hint.
 */
const account = { id: "one", name: "Frida Merian", email: "frida@example.test", isAdmin: true } as Account;
const LABELS = ["Home", "Projects", "Maps", "Workflows", "Data", "Connections", "SQL", "Templates", "Users", "Settings"];

function railItems(mode: RailMode): string {
  return renderToStaticMarkup(
    <RailModeContext.Provider value={mode}>
      <NavLinks />
      <RailUsersLink />
      <RailSettingsLink />
      <UserBadge account={account} />
    </RailModeContext.Provider>,
  );
}
/** The hints on the rail's items, the sign-out control's own left aside. */
const itemHints = (html: string) =>
  [...html.matchAll(/data-hint="([^"]*)"/g)].map(match => match[1]).filter(text => text !== "Sign out");

describe("the rail's hints", () => {
  it("names every link and the account row under Icons only", () => {
    const html = railItems("icons");
    expect(itemHints(html).sort()).toEqual([...LABELS, "Frida Merian"].sort());
    // The labels are in the markup but never shown: the hint shows anyway.
    for (const label of LABELS) {
      expect(html).toMatch(new RegExp(`data-hint="${label}" data-hint-always=""`));
    }
  });

  it("carries no item hint under Opens on hover or Always open", () => {
    for (const mode of ["hover", "open"] as const) expect(itemHints(railItems(mode)), mode).toEqual([]);
  });

  it("reads the pick from the root's attribute, today's behavior for anything else", () => {
    expect(railModeOf(undefined)).toBe("hover");
    expect(railModeOf("open")).toBe("open");
    expect(railModeOf("icons")).toBe("icons");
    expect(railModeOf("hover")).toBe("hover");
    expect(railModeOf("sideways")).toBe("hover");
  });
});

/*
 * What the rail's stylesheet does to its controls, read without a browser:
 * the items' markup under the rail, the root carrying the pick, and the
 * rules of the workspace stylesheet resolved by selector match, specificity
 * and source order. Media blocks are left out (they only quiet motion or
 * move the content column). This is a reading of the cascade, not layout:
 * where the controls land on screen is the browser round's.
 */
type El = { tag: string; classes: string[]; attrs: Map<string, string>; parent: El | null; children: El[] };
type Rule = { selector: string; declarations: Map<string, string>; order: number };

function element(tag: string, attrs: Map<string, string>, parent: El | null): El {
  // A CSS module class renders as `_name_hash`; the stylesheet names `name`.
  const classes = (attrs.get("class") ?? "").split(/\s+/).filter(Boolean).map(name => /^_(\w+)_[0-9a-f]+$/.exec(name)?.[1] ?? name);
  const node: El = { tag, classes, attrs, parent, children: [] };
  parent?.children.push(node);
  return node;
}

/** The items as the workspace layout mounts them, inside the rail, under a root carrying the pick. */
function railTree(mode: RailMode): { rail: El; all: El[] } {
  const root = element("html", new Map(mode === "hover" ? [] : [["data-look-rail", mode]]), null);
  const body = element("body", new Map(), root);
  const rail = element("nav", new Map([["class", "_rail_0"], ["data-hint-place", "beside"]]), body);
  const all: El[] = [rail];
  let open: El = rail;
  for (const [, close, tag, attrText, selfClose] of railItems(mode).matchAll(/<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/)?>/g)) {
    if (close) { open = open.parent!; continue; }
    const attrs = new Map([...attrText.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? ""]));
    const node = element(tag, attrs, open);
    all.push(node);
    if (!selfClose) open = node;
  }
  return { rail, all };
}

function layoutRules(): Rule[] {
  const text = readFileSync("src/app/(workspace)/layout.module.css", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@(media|supports|container)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  let order = 0;
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
    const declarations = new Map(body.split(";").map(part => part.split(/:(.*)/s)).filter(pair => pair.length > 1)
      .map(([property, value]) => [property.trim(), value.trim()]));
    return splitTop(selectors, ",").map(selector => ({ selector: unwrapGlobal(selector.trim()), declarations, order: order++ }));
  });
}

/** Split at a separator outside parentheses and attribute brackets. */
function splitTop(text: string, separator: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && (separator === " " ? /\s|>/.test(char) : char === separator)) { if (current) parts.push(current); current = ""; continue; }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** The CSS modules wrapper is no selector of its own. */
function unwrapGlobal(selector: string): string {
  let out = selector;
  for (let at = out.indexOf(":global("); at !== -1; at = out.indexOf(":global(")) {
    let depth = 0, end = at + ":global(".length;
    for (; end < out.length; end++) {
      if (out[end] === "(") depth++;
      if (out[end] === ")") { if (depth === 0) break; depth--; }
    }
    out = out.slice(0, at) + out.slice(at + ":global(".length, end) + out.slice(end + 1);
  }
  return out;
}

type Part = { kind: "tag" | "class" | "attr" | "pseudo"; name: string; value?: string; arg?: string };
function parts(compound: string): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < compound.length;) {
    const rest = compound.slice(i);
    let match: RegExpExecArray | null;
    if ((match = /^\.([\w-]+)/.exec(rest))) out.push({ kind: "class", name: match[1] });
    else if ((match = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) out.push({ kind: "attr", name: match[1], value: match[2] });
    else if ((match = /^:([\w-]+)\(/.exec(rest))) {
      let depth = 0, end = match[0].length;
      for (; end < rest.length; end++) {
        if (rest[end] === "(") depth++;
        if (rest[end] === ")") { if (depth === 0) break; depth--; }
      }
      out.push({ kind: "pseudo", name: match[1], arg: rest.slice(match[0].length, end) });
      i += end + 1;
      continue;
    } else if ((match = /^:([\w-]+)/.exec(rest))) out.push({ kind: "pseudo", name: match[1] });
    else if ((match = /^(\*|[a-zA-Z][\w-]*)/.exec(rest))) out.push({ kind: "tag", name: match[1] });
    else throw new Error(`unread selector text: ${rest}`);
    i += match[0].length;
  }
  return out;
}

const descendants = (node: El): El[] => node.children.flatMap(child => [child, ...descendants(child)]);

function matchesCompound(node: El, compound: string, focused: El | null): boolean {
  return parts(compound).every(part => {
    switch (part.kind) {
      case "tag": return part.name === "*" || part.name === node.tag;
      case "class": return node.classes.includes(part.name);
      case "attr": return node.attrs.has(part.name) && (part.value === undefined || node.attrs.get(part.name) === part.value);
      case "pseudo":
        if (part.name === "root") return node.parent === null;
        if (part.name === "not") return !matchesCompound(node, part.arg!, focused);
        if (part.name === "has") return descendants(node).some(inner => matchesCompound(inner, part.arg!, focused));
        if (part.name === "focus-visible" || part.name === "focus") return node === focused;
        if (part.name === "focus-within") return focused !== null && (node === focused || descendants(node).includes(focused));
        return false; // :hover, :active and the rest: no pointer rests anywhere
    }
  });
}

function matches(node: El, selector: string, focused: El | null): boolean {
  const compounds = splitTop(selector, " ");
  if (!matchesCompound(node, compounds[compounds.length - 1], focused)) return false;
  let at = node.parent;
  for (let i = compounds.length - 2; i >= 0; i--) {
    while (at && !matchesCompound(at, compounds[i], focused)) at = at.parent;
    if (!at) return false;
    at = at.parent;
  }
  return true;
}

function specificity(compound: string): number {
  return parts(compound).reduce((sum, part) => {
    if (part.kind === "tag") return sum + (part.name === "*" ? 0 : 1);
    if (part.kind === "pseudo" && (part.name === "not" || part.name === "has" || part.name === "is"))
      return sum + Math.max(...splitTop(part.arg!, ",").map(arg => splitTop(arg, " ").reduce((s, c) => s + specificity(c), 0)));
    if (part.kind === "pseudo" && part.name === "where") return sum;
    return sum + 1000;
  }, 0);
}

/** The winning value of a property on a node, or undefined when no rule sets it. */
function computed(node: El, property: string, focused: El | null): string | undefined {
  const winner = layoutRules()
    .filter(rule => rule.declarations.has(property) && matches(node, rule.selector, focused))
    .map(rule => ({ rule, weight: splitTop(rule.selector, " ").reduce((s, c) => s + specificity(c), 0) }))
    .sort((a, b) => a.weight - b.weight || a.rule.order - b.rule.order)
    .at(-1);
  return winner?.rule.declarations.get(property);
}

/** Why a node cannot be seen, or null: it or an ancestor inside the rail is transparent, hidden or not drawn. */
function unseen(node: El, rail: El, focused: El | null): string | null {
  for (let at: El | null = node; at && at !== rail.parent; at = at.parent) {
    if (computed(at, "opacity", focused) === "0") return `${at.classes.join(".")} opacity 0`;
    if (computed(at, "visibility", focused) === "hidden") return `${at.classes.join(".")} visibility hidden`;
    if (computed(at, "display", focused) === "none") return `${at.classes.join(".")} display none`;
  }
  return null;
}

const MODES = ["hover", "open", "icons"] as const;
const focusable = (node: El) => (node.tag === "a" && node.attrs.has("href")) || (node.tag === "button" && !node.attrs.has("disabled"));
const signOut = (all: El[]) => all.find(node => node.attrs.get("aria-label") === "Sign out")!;

describe("the rail's controls are seen", () => {
  it("every control that takes focus in the rail is seen while it has it, under each pick", () => {
    for (const mode of MODES) {
      const { rail, all } = railTree(mode);
      const controls = all.filter(focusable);
      // Every link, the account row and Sign out.
      expect(controls.length, mode).toBe(LABELS.length + 2);
      for (const control of controls) {
        expect(unseen(control, rail, control), `${mode}: ${control.attrs.get("aria-label") ?? control.attrs.get("href")}`).toBeNull();
      }
    }
  });

  it("shows Sign out under Icons only as an icon with its hint, in the account row after the account", () => {
    const { rail, all } = railTree("icons");
    const out = signOut(all);
    expect(out.attrs.get("data-hint")).toBe("Sign out");
    // Seen and clickable at rest, with nothing focused and no pointer on the rail.
    expect(unseen(out, rail, null)).toBeNull();
    expect(computed(out, "pointer-events", null)).not.toBe("none");
    // In the rail's icon column below the account, not laid over its avatar.
    expect(computed(out, "position", null)).not.toBe("absolute");
    expect(out.parent!.classes).toContain("accountRow");
    const row = out.parent!.children;
    expect(row[row.indexOf(out) - 1].attrs.get("href")).toBe("/settings#account");
  });

  it("leaves Sign out as it was under the other two picks", () => {
    const hover = railTree("hover");
    // Out of sight and out of the pointer's way until the rail opens.
    expect(unseen(signOut(hover.all), hover.rail, null)).toMatch(/opacity 0/);
    expect(computed(signOut(hover.all), "pointer-events", null)).toBe("none");
    const open = railTree("open");
    // At the right end of the account row of the rail standing open.
    expect(unseen(signOut(open.all), open.rail, null)).toBeNull();
    expect(computed(signOut(open.all), "position", null)).toBe("absolute");
  });
});
