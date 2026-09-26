import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AssistantRecord } from "./AssistantRecord";
import type { RecordEntry } from "./record-projection";

/**
 * The note as rendered ('s structure, 4f, 4g, 4h, 5b's pane half, 6b's
 * note half): the thumbnail button before the words, "Checked the map."
 * then the observation with its state, markdown literal, no identifier on
 * the line, the inspection with identity, state, appearance and sizes and
 * no history line; a failed check with its words and neither thumbnail nor
 * observation.
 */
const check: NonNullable<RecordEntry["check"]> = { renderId: "render-1", mapId: "m", appearance: "dark", stateDigest: "abcdefabcdefabcd", layers: 2, widgets: 1, image: { width: 768, height: 480, bytes: 300 * 1024 }, source: { width: 1024, height: 640 }, attribution: "© Fixture", failures: [], abandoned: [] };
const base: RecordEntry = { id: "c1", tool: "look_at_map", label: "Checked the map", status: "succeeded", inputs: [], omitted: false, elapsed: "1.2 s", check };
const port = { active: [], failures: [], start: () => {}, dismiss: () => {} } as never;
const html = (entry: RecordEntry, open = false) => renderToStaticMarkup(createElement(AssistantRecord, { entries: [entry], layerDataDownloads: port, doors: false, open: open ? [entry.id] : [] }));

describe("the note's line", () => {
  it("thumbnail button first, then the words with the observation and its state, the identifier off the line", () => {
    const out = html({ ...base, observation: { state: "captured", text: "**Five** greens read light to dark.", at: 0 } });
    expect(out.indexOf("data-check-thumb")).toBeLessThan(out.indexOf("data-check-words"));
    expect(out).toContain('aria-label="Open the image the model was given"');
    expect(out).toContain('src="/api/maps/look/render-1?variant=thumbnail"');
    expect(out).toContain("<b>Checked the map.</b>");
    expect(out).toContain('data-observation-state="captured"');
    // Markdown literal, as typed.
    expect(out).toContain("**Five** greens read light to dark.");
    expect(out).not.toContain("<strong>");
    // The line carries no identifier; the closed inspection is absent.
    expect(out).not.toContain("look_at_map</p>");
    expect(out).not.toContain("data-inspection");
  });
  it("each non-captured state has words on the line", () => {
    for (const [observation, words] of [
      [{ state: "awaited" }, "Looking at it."],
      [{ state: "silent" }, "The model said nothing about it."],
      [{ state: "interrupted", reason: "exhausted" }, "The request's budget ran out before the model described it."],
      [{ state: "unavailable" }, "The model's words were not kept."],
    ] as const) {
      const out = html({ ...base, observation });
      expect(out).toContain(`data-observation-state="${observation.state}"`);
      expect(out.replace(/&#x27;/g, "'")).toContain(words);
    }
  });
  it("the inspection carries the render identity, the state identity, the appearance and both sizes, and claims no undo or change group", () => {
    const out = html({ ...base, observation: { state: "captured", text: "Seen.", at: 0 } }, true);
    expect(out).toContain('data-render-id="true">render-1<');
    expect(out).toMatch(/data-render-state="true">abcdefabcdefabcd, 2 visible layers, 1 widget</);
    expect(out).toContain("dark");
    expect(out).toContain("768 by 480, 300 KiB");
    expect(out).toContain("1024 by 640");
    expect(out).not.toContain("data-history");
    expect(out.toLowerCase()).not.toContain("undo");
    expect(out.toLowerCase()).not.toContain("change group");
    expect(out).toContain("look_at_map</p>");
  });
  it("dropped state detail reads as not kept in the inspection, never as zero layers and widgets", () => {
    const out = html({ ...base, omitted: true, check: { ...check, layers: undefined, widgets: undefined } }, true);
    expect(out).toMatch(/data-render-state="true">abcdefabcdefabcd, layer and widget detail not kept</);
    expect(out).not.toContain("0 visible layers");
    expect(out).not.toContain("0 widgets");
  });
  it("a failed layer, a failed widget and an abandoned request each show in the inspection, and the line still says the map was checked", () => {
    const cases: [Partial<NonNullable<RecordEntry["check"]>>, string][] = [
      [{ failures: ["Parks: could not render"], abandoned: [] }, "Parks: could not render"],
      [{ failures: ["Widget values failed."], abandoned: [] }, "Widget values failed."],
      [{ failures: [], abandoned: ["tiles.example.org", "tiles.example.org"] }, "2 requests to tiles.example.org"],
    ];
    for (const [facts, needle] of cases) {
      const out = html({ ...base, check: { ...check, ...facts }, observation: { state: "captured", text: "Seen.", at: 0 } }, true);
      expect(out).toContain("<b>Checked the map.</b>");
      expect(out).toContain(needle);
    }
    const clean = html({ ...base, observation: { state: "captured", text: "Seen.", at: 0 } }, true);
    expect(clean).not.toContain("data-check-failures");
    expect(clean).not.toContain("data-check-abandoned");
  });
  it("a failed check shows its words and neither thumbnail nor observation", () => {
    const out = html({ ...base, status: "refused", check: undefined, failure: { code: "render_timeout", message: "The image render exceeded the 30 s check budget (queue wait included)." }, observation: undefined });
    expect(out).toContain('data-failure-code="render_timeout"');
    expect(out).toContain("The picture could not be taken in time.");
    expect(out).not.toContain("queue wait");
    expect(out).not.toContain("data-check-thumb");
    expect(out).not.toContain("data-observation");
  });
});
