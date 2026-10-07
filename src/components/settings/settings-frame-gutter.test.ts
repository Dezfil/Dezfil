import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The page's scrollbar and the Settings tab's left edge. Past the shell's
 * 1720 px breakpoint the workspace centers its content on the width left
 * beside the page's scrollbar, so a classic scrollbar (a Mac set to show
 * scroll bars always) that came with a tab taller than the window and went
 * with a shorter one moved the whole page sideways by half its width on
 * each such tab change. While the Settings screen is on the page, the root
 * keeps the scrollbar's room whether the tab needs it or not. The journey
 * measures the edge in a browser; this holds the stylesheet's part.
 */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = (path: string) => source(path).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule { readonly selector: string; readonly body: string }

/** The stylesheet's rules outside any at-rule: a rule inside a media query holds at some widths only. */
function topLevel(text: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0, start = 0, selector = "", open = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") {
      if (depth === 0) { selector = text.slice(start, i).trim(); open = i + 1; }
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!selector.startsWith("@")) rules.push({ selector: selector.replace(/\s+/g, " "), body: text.slice(open, i) });
        start = i + 1;
      }
    }
  }
  return rules;
}

const declared = (body: string, property: string) =>
  [...body.matchAll(new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`, "g"))].map(match => match[1].trim());

describe("the Settings page's left edge", () => {
  it("rests on a shell that centers on the width beside the scrollbar past its breakpoint", () => {
    const main = topLevel(css("../../app/(workspace)/layout.module.css")).find(rule => rule.selector === ".main");
    expect(main, "the shell's content rule").toBeDefined();
    // A percentage resolves against the body, which a classic scrollbar narrows.
    expect(declared(main!.body, "margin").join(" ")).toMatch(/\(100% - /);
  });

  it("keeps the scrollbar's room on the root while the Settings screen is on the page, at every width", () => {
    const rules = topLevel(css("./SettingsFrame.module.css")).filter(rule => /^:global\((?::root|html)\):has\(\.screen\)$/.test(rule.selector));
    expect(rules.flatMap(rule => declared(rule.body, "scrollbar-gutter"))).toEqual(["stable"]);
  });

  it("puts that class on the frame's outermost element", () => {
    expect(source("./SettingsFrame.tsx")).toMatch(/return <div className=\{styles\.screen\}>/);
  });
});
