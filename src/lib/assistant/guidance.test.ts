import { testAccountScope } from "@/lib/test-support/accounts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PALETTES } from "@/lib/style/palettes";
import { buildTools } from "@/lib/tools/tools";
import { CATEGORY_CEILING, GUIDANCE_PALETTES, GUIDANCE_SECTIONS, analyticalGuidance } from "./guidance";
import { runAssistant } from "./loop";
import { PendingActionStore } from "./pending";
import { corePrompt, systemPrompt } from "./prompt";
import { stubProvider } from "./providers/stub";

/**
 * The guidance: each discipline reaches a captured provider request;
 * one production source supplies it and changing the source changes the
 * capture; no avoidance instruction anywhere the model reads; the H3
 * sentence claims nothing about the visual hexbin's cell size and every
 * palette named exists in the registry with the kind the guidance gives
 * it.
 */

/** A sentence only the guidance carries: the one-source scan's needle. */
const NEEDLE = "a plain box overlap loses the matches the distance is for";

async function capturedSystem(): Promise<string> {
  const provider = stubProvider([{ text: "Hello.", toolCalls: [] }]);
  const events = runAssistant(provider, { message: "Hi", history: [] }, { scope: testAccountScope(), baseUrl: "http://127.0.0.1:3000", pending: new PendingActionStore() });
  for await (const event of events) void event;
  return provider.recording.exchanges[0].options.system;
}

function* production(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* production(full);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) yield full;
  }
}

describe("each discipline reaches the provider request", () => {
  it("the captured system prompt carries every section, read from the request and not the source", async () => {
    const system = await capturedSystem();
    for (const section of GUIDANCE_SECTIONS.filter(section => section.audience !== "package")) expect(system, section.id).toContain(section.text);
    // The disciplines by their sentences, not by the section list alone.
    expect(system).toContain("Read the grounding block before writing any SQL");
    expect(system).toContain("conservative candidate filter appropriate to the predicate, then the exact predicate");
    expect(system).toContain("envelope expanded by that distance");
    expect(system).toContain("never reported as metres");
    expect(system).toContain("a projection alone does not imply metres");
    expect(system).toContain("An empty result is an answer");
    expect(system).toContain("Do not encode one variable twice");
    expect(system).toContain("no rainbow ramp");
    expect(system).toContain("keep hand-set boundaries as round as computed ones");
    // The core prompt is unchanged beneath it.
    expect(system.startsWith(corePrompt())).toBe(true);
  });
});

describe("one production source", () => {
  it("exactly one production file under src carries the guidance's sentence", () => {
    const carriers = [...production("src")].filter((file) => readFileSync(file, "utf8").includes(NEEDLE));
    expect(carriers).toEqual(["src/lib/assistant/guidance.ts"]);
  });
  it("changing the source changes the captured request", async () => {
    vi.resetModules();
    vi.doMock("./guidance", () => ({ analyticalGuidance: () => "MARKER-the source changed", GUIDANCE_SECTIONS: [], GUIDANCE_PALETTES: { sequential: [], diverging: [], categorical: [] }, CATEGORY_CEILING: 10 }));
    try {
      const { systemPrompt: changed } = await import("./prompt");
      expect(changed()).toContain("MARKER-the source changed");
      expect(changed()).not.toContain(NEEDLE);
    } finally { vi.doUnmock("./guidance"); vi.resetModules(); }
    expect(systemPrompt()).toContain(NEEDLE);
  });
});

describe("no avoidance instruction", () => {
  const AVOIDANCE = /\b(never|do not|don't|avoid) (call|calling|use|using|run|running)\b[^.]{0,40}\b(tool|operation|endpoint|route|api)\b|\b(never|do not|don't) (call|use) \w+_\w+/i;
  it("the guidance and the prompt tell the model to avoid no operation, mechanically for the shapes", () => {
    expect(analyticalGuidance()).not.toMatch(AVOIDANCE);
    expect(systemPrompt()).not.toMatch(AVOIDANCE);
    for (const tool of buildTools()) expect(tool.description, tool.name).not.toMatch(AVOIDANCE);
  });
  it("and the seeded shape is what the check catches", () => {
    expect("Never call the undo tool from /sql.").toMatch(AVOIDANCE);
    expect("Do not use this operation on the canvas.").toMatch(AVOIDANCE);
    expect("never use delete_map").toMatch(AVOIDANCE);
  });
});

describe("H3 and the palettes", () => {
  it("the H3 sentence keeps H3 for the index and claims nothing about the visual hexbin's cell size", () => {
    const sentence = GUIDANCE_SECTIONS.find((s) => s.id === "classification")!.text;
    expect(sentence).toContain("H3 stays the index for widgets and index workflows");
    expect(sentence).toContain("planar tessellation at any cell size");
    expect(sentence).toContain("an H3 resolution is not a cell size");
    expect(sentence).not.toMatch(/resolution \d+/);
  });
  it("every palette the guidance names exists in the registry in the group it gives it", () => {
    // The registry's kind is the mechanical axis (sequential or categorical);
    // diverging is the browsing group, which is what the guidance names.
    const byName = new Map(PALETTES.map((p) => [p.name, p.group]));
    for (const name of GUIDANCE_PALETTES.sequential) expect(byName.get(name), name).toBe("sequential");
    for (const name of GUIDANCE_PALETTES.diverging) expect(byName.get(name), name).toBe("diverging");
    for (const name of GUIDANCE_PALETTES.categorical) expect(byName.get(name), name).toBe("qualitative");
    expect(CATEGORY_CEILING).toBe(10);
  });
});
