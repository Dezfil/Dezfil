import { testAccountScope } from "@/lib/test-support/accounts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { continuationText } from "./check-turn";
import { GUIDANCE_SECTIONS, analyticalGuidance } from "./guidance";
import { runAssistant } from "./loop";
import { PendingActionStore } from "./pending";
import { corePrompt, systemPrompt } from "./prompt";
import { stubProvider } from "./providers/stub";

/**
 * What the model is told about a render: the render-reading craft reaches
 * a captured provider request, read from the request; it lives in the one
 * production source, a seeded second inclusion failing; and no sentence
 * of it, of the prompt, of the check's tool descriptions or of the words
 * handed beside the image tells the model to avoid an operation,
 * mechanically for the avoidance shapes.
 */
const NEEDLE = "do not claim anything the image does not show";

async function capturedSystem(): Promise<string> {
  const provider = stubProvider([{ text: "Hello.", toolCalls: [] }]);
  for await (const event of runAssistant(provider, { message: "Hi", history: [] }, { scope: testAccountScope(), baseUrl: "http://127.0.0.1:3000", pending: new PendingActionStore() })) void event;
  return provider.recording.exchanges[0].options.system;
}
function* production(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* production(full);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) yield full;
  }
}

describe("the craft reaches the provider request", () => {
  it("the captured system prompt carries the render-reading section, read from the request", async () => {
    const system = await capturedSystem();
    const section = GUIDANCE_SECTIONS.find((s) => s.id === "render-reading");
    expect(section).toBeDefined();
    expect(system).toContain(section!.text);
    expect(system).toContain("name what is visible in it");
    expect(system).toContain(NEEDLE);
    expect(system).toContain("Say which map and which rendered state you are describing");
    expect(system).toContain("Compare what you see against what was asked for");
    expect(system).toContain("Propose at most one change, and leave it for the person to decide");
    expect(system.startsWith(corePrompt())).toBe(true);
  });
});

describe("one production source", () => {
  it("exactly one production file under src carries the craft's sentence", () => {
    const carriers = [...production("src")].filter((file) => readFileSync(file, "utf8").includes(NEEDLE));
    expect(carriers).toEqual(["src/lib/assistant/guidance.ts"]);
  });
  it("a seeded second inclusion is caught by that scan, and changing the source changes the capture", async () => {
    // The scan's needle appearing in a second production file is what it catches.
    const seeded = [...production("src"), "src/lib/assistant/seeded-copy.ts"];
    const reads = (file: string) => file.endsWith("seeded-copy.ts") ? `export const copy = "${NEEDLE}";` : readFileSync(file, "utf8");
    expect(seeded.filter((file) => reads(file).includes(NEEDLE))).toEqual(["src/lib/assistant/guidance.ts", "src/lib/assistant/seeded-copy.ts"]);
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

describe("no avoidance sentence, mechanically for the shapes", () => {
  const AVOIDANCE = /\b(never|do not|don't|avoid|must not|should not|refrain from) (call|calling|use|using|run|running|invoke|invoking|look|looking|check|checking|render|rendering|request|requesting)\b[^.]{0,60}\b(tool|operation|endpoint|route|api|check|render|image|map)\b|\b(never|do not|don't|avoid) (call|use|run) \w+_\w+/i;
  const WARNING = /\b(slow|latency|timeout|time out|budget|expensive|costly|unreliable|may fail|might fail|can fail)\b/i;
  it("the render-reading section, the prompt, the check's tool descriptions and the words beside the image", () => {
    const section = GUIDANCE_SECTIONS.find((s) => s.id === "render-reading")!.text;
    expect(section).not.toMatch(AVOIDANCE);
    expect(section).not.toMatch(WARNING);
    expect(analyticalGuidance()).not.toMatch(AVOIDANCE);
    expect(systemPrompt()).not.toMatch(AVOIDANCE);
    for (const name of ["look_at_map", "read_map_look_image"]) {
      const tool = buildTools().find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.description, name).not.toMatch(AVOIDANCE);
      expect(tool.description, name).not.toMatch(/\b(never|do not|don't|avoid)\b/i);
    }
    const beside = continuationText({ mapName: "Parks", image: { width: 1024, height: 640 } }, { render: { id: "r" } });
    expect(beside).not.toMatch(AVOIDANCE);
    expect(beside).not.toMatch(WARNING);
    expect(beside).not.toMatch(/\b(never|do not|don't|avoid|should|must)\b/i);
  });
  it("and the seeded shapes are what the sweep catches", () => {
    expect("Do not call the check again after looking.").toMatch(AVOIDANCE);
    expect("Never use look_at_map on the canvas.").toMatch(AVOIDANCE);
    expect("Avoid requesting a render of this map.").toMatch(AVOIDANCE);
    expect("The render road is slow.").toMatch(WARNING);
  });
});
