import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { BANDS, MARK_D, SMALL_D } from "./logo-mark-geometry";
import { LogoMark, type LogoMarkProps } from "./LogoMark";

/**
 * The product's icon, the contour D. Still, it is one filled path: the full
 * mark at 24 px and up, the small version (no middle ring, a larger centre)
 * below. Shimmering, it is the three bands redrawn every frame, easing in
 * from the still icon; reduced motion keeps it still, and leaving the page
 * stops the frames. The frame clock and the motion preference are fakes.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

/** A frame clock the test advances by hand. */
function frames() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  vi.stubGlobal("requestAnimationFrame", (fn: (now: number) => void) => { pending.set(next, fn); return next++; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { pending.delete(id); });
  return {
    pending: () => pending.size,
    run(now: number) {
      const due = [...pending.values()];
      pending.clear();
      act(() => due.forEach((fn) => fn(now)));
    },
  };
}

function mount(props: LogoMarkProps, reduced = false) {
  const host = installDomHost();
  Object.assign(host.window, {
    matchMedia: (query: string) => ({ matches: reduced && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }),
  });
  const box = host.document.createElement("div");
  host.document.body.appendChild(box);
  const root = createRoot(box as unknown as Element);
  act(() => root.render(<LogoMark {...props} />));
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; act(() => root.unmount()); } };
  cleanups.push(() => { unmount(); host.uninstall(); });
  const svg = box.querySelector("svg") as HostElement;
  return { svg, paths: () => svg.querySelectorAll("path"), unmount };
}

describe("the still mark", () => {
  it("is the full contour D at 24 px and up, named Dezfil", () => {
    const { svg, paths } = mount({ size: 30 });
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Dezfil");
    expect(svg.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(svg.getAttribute("width")).toBe("30");
    expect(paths().map((p) => p.getAttribute("d"))).toEqual([MARK_D]);
  });

  it("draws the small version under 24 px", () => {
    const { paths } = mount({ size: 16 });
    expect(paths().map((p) => p.getAttribute("d"))).toEqual([SMALL_D]);
    expect(SMALL_D).not.toBe(MARK_D);
  });

  it("inks in the accent unless it sits on a filled tile", () => {
    expect(mount({}).svg.getAttribute("data-tone")).toBe("accent");
    expect(mount({ tone: "current" }).svg.getAttribute("data-tone")).toBe("current");
    const css = readFileSync("src/components/LogoMark.module.css", "utf8");
    expect(css).toMatch(/\.mark path \{\s*fill: var\(--accent\);/);
    expect(css).toMatch(/\.mark\[data-tone="current"\] path \{\s*fill: currentColor;/);
  });
});

describe("the shimmer", () => {
  it("draws the three bands, named Loading, and moves them frame by frame", () => {
    const clock = frames();
    const { svg, paths } = mount({ size: 30, motion: "shimmer" });
    expect(svg.getAttribute("aria-label")).toBe("Loading");
    expect(paths().map((p) => p.getAttribute("d"))).toEqual([...BANDS]);
    expect(clock.pending()).toBe(1);
    clock.run(1000);
    clock.run(1100);
    const early = paths().map((p) => p.getAttribute("d"));
    for (let i = 1; i <= 15; i++) clock.run(1100 + i * 100);
    const later = paths().map((p) => p.getAttribute("d"));
    expect(later).not.toEqual([...BANDS]);
    expect(later).not.toEqual(early);
    expect(clock.pending()).toBe(1);
  });

  it("drops the middle ring and grows the centre under 24 px", () => {
    frames();
    const { paths } = mount({ size: 20, motion: "shimmer" });
    const [outer, middle, centre] = paths();
    expect(outer.getAttribute("display")).toBeNull();
    expect(middle.getAttribute("display")).toBe("none");
    expect(centre.getAttribute("transform")).toMatch(/scale\(1\.3\)$/);
  });

  it("stays still under reduced motion", () => {
    const clock = frames();
    const { paths } = mount({ motion: "shimmer" }, true);
    expect(clock.pending()).toBe(0);
    expect(paths().map((p) => p.getAttribute("d"))).toEqual([...BANDS]);
  });

  it("stops drawing when it leaves the page", () => {
    const clock = frames();
    const { unmount } = mount({ motion: "shimmer" });
    expect(clock.pending()).toBe(1);
    unmount();
    expect(clock.pending()).toBe(0);
  });
});

describe("the favicon", () => {
  const icon = readFileSync("src/app/icon.svg", "utf8");
  const globals = readFileSync("src/app/globals.css", "utf8");
  const accents = [...globals.matchAll(/^\s*--accent:\s*(#[0-9a-f]{6});/gim)].map((m) => m[1].toLowerCase());

  it("is the small contour D", () => {
    const d = [...icon.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
    expect(d).toEqual([SMALL_D]);
  });

  it("inks in the light accent and switches to the dark one in dark mode", () => {
    expect(accents.length).toBeGreaterThanOrEqual(2);
    const [light, dark] = accents;
    const style = /<style>([\s\S]*?)<\/style>/.exec(icon)?.[1] ?? "";
    const [base, darkMode] = style.split("@media (prefers-color-scheme:dark)");
    expect(base.toLowerCase()).toContain(`fill:${light}`);
    expect(darkMode?.toLowerCase()).toContain(`fill:${dark}`);
  });

  it("carries no embedded metadata", () => {
    expect(icon).not.toMatch(/<metadata|c2pa/i);
  });
});
