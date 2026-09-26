import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  ...(await import("../workflow-canvas/hook-harness")).hookReact,
}));
import { HookHarness } from "../workflow-canvas/hook-harness";
import { useLingering } from "./use-lingering";

afterEach(() => vi.useRealTimers());

/** the builder's saving indication
 * had a readable exit because its span kept a permanently mounted
 * literal — the very reservation removed. The exit comes back as a held
 * flag, and only where one existed. */
describe("a flag that lingers past its producer", () => {
  it("passes straight through when nothing is held", () => {
    let on = true;
    const h = new HookHarness(() => useLingering(on, 0));
    expect(h.value).toBe(true);
    on = false;
    expect(h.render()).toBe(false);
  });

  it("stays raised for its window, then drops", () => {
    vi.useFakeTimers();
    let on = true;
    const h = new HookHarness(() => useLingering(on, 450));
    expect(h.value).toBe(true);
    on = false;
    expect(h.render(), "still raised the moment the producer lowers it").toBe(true);
    vi.advanceTimersByTime(300);
    expect(h.render(), "and through the fade").toBe(true);
    vi.advanceTimersByTime(200);
    expect(h.render(), "then down").toBe(false);
  });

  it("a producer that speaks again inside the window re-arms the whole hold", () => {
    vi.useFakeTimers();
    let on = true;
    const h = new HookHarness(() => useLingering(on, 450));
    on = false;
    h.render();
    vi.advanceTimersByTime(200);
    on = true;
    expect(h.render()).toBe(true);
    on = false;
    h.render();
    vi.advanceTimersByTime(400);
    expect(h.render(), "the second lowering has its own full window").toBe(true);
    vi.advanceTimersByTime(100);
    expect(h.render()).toBe(false);
  });

  it("drops its timer on unmount", () => {
    vi.useFakeTimers();
    let on = true;
    const h = new HookHarness(() => useLingering(on, 450));
    on = false;
    h.render();
    h.unmount();
    expect(vi.getTimerCount(), "no timer left running for a gone chip").toBe(0);
  });
});
