import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the browser draws itself follows the theme: scrollbars, form popups
 * and the bare canvas a hidden page shows while the session is read again
 * after a tab switch. Scrollbars stay out of sight until the pointer is over
 * what they scroll. Held here in the stylesheet; how it looks is judged by eye.
 */

/** Each flat rule's declarations, by selector, comments removed. */
function declarations(css: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const values = new Map<string, string>();
    for (const declaration of match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) {
      values.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    }
    for (const selector of match[1].split(",")) {
      const key = selector.trim().replace(/\s+/g, " ");
      out.set(key, new Map([...(out.get(key) ?? []), ...values]));
    }
  }
  return out;
}

const GLOBALS = declarations(readFileSync("src/app/globals.css", "utf8"));

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) return stylesheets(file);
    return file.endsWith(".css") ? [file] : [];
  });
}

describe("the browser's own parts", () => {
  it("take the dark scheme with the dark theme", () => {
    expect(GLOBALS.get(':root[data-theme="dark"]')?.get("color-scheme")).toBe("dark");
    expect(GLOBALS.get('[data-view-theme="dark"]')?.get("color-scheme")).toBe("dark");
  });

  it("keep every scrollbar clear until the pointer is over what it scrolls", () => {
    expect(GLOBALS.get("*")?.get("scrollbar-color")).toBe("transparent transparent");
    const shown = GLOBALS.get("*:hover")?.get("scrollbar-color") ?? "";
    expect(shown.split(" ")[0]).toMatch(/^var\(--/);
    expect(GLOBALS.get("::-webkit-scrollbar-thumb")?.get("background")).toBe("transparent");
    expect(GLOBALS.get(":hover::-webkit-scrollbar-thumb")?.get("background-color")).toMatch(/^var\(--/);
  });

  it("leave the scrollbar's colors to that one rule", () => {
    const own = stylesheets("src")
      .filter(file => file !== path.join("src", "app", "globals.css"))
      .filter(file => /scrollbar-color|::-webkit-scrollbar/.test(readFileSync(file, "utf8")));
    expect(own).toEqual([]);
  });
});
