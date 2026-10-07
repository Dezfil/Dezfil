import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => {
  const { hookReact } = await import("./workflow-canvas/hook-harness");
  return { ...(await original<object>()), ...hookReact, useLayoutEffect: hookReact.useEffect };
});
const rail = vi.hoisted(() => ({ mode: "hover" as "hover" | "open" | "icons" }));
vi.mock("./rail-mode", async (original) => ({ ...(await original<object>()), useRailMode: () => rail.mode }));
vi.mock("next/navigation", () => ({ usePathname: () => "/maps" }));
import { HookHarness } from "./workflow-canvas/hook-harness";
import { RailShell } from "./RailShell";

/**
 * The rail under the person's Side menu pick. Opens on hover is today's
 * dwell; Always open stands the rail open by the stylesheet and Icons only
 * never opens, so under either a resting pointer must not expand it. The
 * hook bodies run here; how the rail looks is the browser round's.
 */
type Nav = { props: Record<string, unknown> & { children: { props: { value: string } } } };
const RAIL_BOX = { left: 14, width: 54 };

function shell() {
  const h = new HookHarness(() => RailShell({ className: "rail", children: null }) as unknown as Nav);
  (h.value.props.ref as { current: unknown }).current = { getBoundingClientRect: () => RAIL_BOX };
  return h;
}
/** A pointer resting inside the rail past the dwell. */
function rest(h: HookHarness<Nav>) {
  (h.value.props.onPointerMove as (event: object) => void)({ pointerType: "mouse", clientX: 30 });
  vi.advanceTimersByTime(250);
  return h.render();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rail.mode = "hover";
});

describe("the rail under the Side menu pick", () => {
  it("opens for a resting pointer under Opens on hover, as today", () => {
    rail.mode = "hover";
    expect(rest(shell()).props["data-expanded"]).toBe(true);
  });

  it("never expands for a resting pointer under Always open or Icons only", () => {
    for (const mode of ["open", "icons"] as const) {
      rail.mode = mode;
      expect(rest(shell()).props["data-expanded"], mode).toBeUndefined();
    }
  });

  it("lets an expansion go when the pick leaves Opens on hover", () => {
    rail.mode = "hover";
    const h = shell();
    expect(rest(h).props["data-expanded"]).toBe(true);
    rail.mode = "icons";
    expect(h.render().props["data-expanded"]).toBeUndefined();
  });

  it("hands its items the pick, and asks for hints beside the icon", () => {
    for (const mode of ["hover", "open", "icons"] as const) {
      rail.mode = mode;
      const nav = shell().value;
      expect(nav.props.children.props.value, mode).toBe(mode);
      expect(nav.props["data-hint-place"]).toBe("beside");
    }
  });
});
