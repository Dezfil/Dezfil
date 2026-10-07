import { afterEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_EDGE, currentStageEdge } from "./use-stage-edge";

/**
 * The camera's left padding is the stage's left edge, summed from the
 * properties that define it: the base, what an open drawer adds and what
 * the always-open rail adds. A part left out frames the map for a stage
 * that is not there.
 */
function computed(values: Record<string, string>) {
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", { getComputedStyle: () => ({ getPropertyValue: (name: string) => values[name] ?? "" }) });
}
afterEach(() => vi.unstubAllGlobals());
/** The wide breakpoint's base, written as the first paint's number: the
 * stage-edge check holds the edge's literal to its one definition. */
const BASE = `${FALLBACK_EDGE}px`;

describe("the stage's left edge, as the camera reads it", () => {
  it("is the base and an open drawer, as before", () => {
    computed({ "--stage-left-base": BASE, "--drawer-offset": "354px", "--rail-shift": "0px" });
    expect(currentStageEdge()).toBe(792);
  });

  it("moves right with the always-open rail", () => {
    computed({ "--stage-left-base": BASE, "--drawer-offset": "0px", "--rail-shift": "156px" });
    expect(currentStageEdge()).toBe(594);
    computed({ "--stage-left-base": "82px", "--drawer-offset": "0px", "--rail-shift": "156px" });
    expect(currentStageEdge()).toBe(238);
  });

  it("reads a missing shift as none, and an unreadable base as the first paint's", () => {
    computed({ "--stage-left-base": BASE, "--drawer-offset": "0px" });
    expect(currentStageEdge()).toBe(438);
    computed({ "--stage-left-base": "calc(1px)", "--rail-shift": "156px" });
    expect(currentStageEdge()).toBe(FALLBACK_EDGE);
  });
});
