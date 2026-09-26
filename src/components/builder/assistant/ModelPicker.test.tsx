import shipped from "@/lib/assistant/model-catalogue.json";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { describeModel } from "@/lib/assistant/model-knowledge";
import { ModelPicker } from "./ModelPicker";
import { ModelMenu } from "./ModelMenu";
import { modelChoice } from "./model-choice-store";
import { chipWords, chooseModel, pickerShown } from "./model-choice";

/**
 * The picker at the composer's footer.
 *
 * Rendered markup, not layout: this environment has no box model, so the
 * two referenced widths belong to the browser pass and conformance to the
 * visual reference stays a judgment call. What is decided here is what the markup
 * says: which control stands, what it reads, what the menu offers, and
 * which states disable it.
 */

const OPENAI = ["gpt-5.6-terra", "gpt-6-astra"].map((id) => describeModel("openai", id, shipped));
const ANTHROPIC = ["claude-opus-5", "claude-sonnet-5"].map((id) => describeModel("anthropic", id, shipped));
/** An identity Dezfil knows nothing about: it reads as itself and offers
 * no levels, which is page 04's "No effort setting". */
const UNKNOWN = ["gpt-5.6-terra", "an-unlisted-model"].map((id) => describeModel("openai", id, shipped));

const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const picker = (props: { models?: typeof OPENAI; instanceModel?: string; disabled?: boolean; bound?: { model: string; effort: string } } = {}) =>
  renderToStaticMarkup(
    <ModelPicker
      models={props.models ?? OPENAI}
      instanceModel={props.instanceModel ?? "gpt-5.6-terra"}
      disabled={props.disabled ?? false}
      bound={props.bound}
    />,
  );
const menu = (models: typeof OPENAI, choice: { model: string; effort: string }) =>
  renderToStaticMarkup(<ModelMenu models={models} choice={choice} onPickModel={() => {}} onPickEffort={() => {}} />);

beforeEach(() => modelChoice.resetForTests());

describe("whether the picker stands at all", () => {
  it("a single-model instance offers no picker, and several models do", () => {
    expect(pickerShown([describeModel("openai", "gpt-5.6-terra", shipped)])).toBe(false);
    expect(pickerShown(OPENAI)).toBe(true);
    // An instance whose status reports no list at all.
    expect(pickerShown([])).toBe(false);
  });
});

describe("the chip at rest", () => {
  it("reads the instance default's display name, with no effort word for the provider default", () => {
    const html = picker();
    expect(html).toContain("data-model-picker");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(visible(html)).toBe("Terra");
    // The menu is not in the document until it is opened.
    expect(html).not.toContain('role="menu"');
  });

  it("shows each model's own effort word, so no shared scale is substituted", () => {
    // Criterion 5h, two models whose own words differ: Terra offers
    // "minimal", which Astra does not; Opus offers "max", which Sonnet does
    // not. Each word comes from that model's own list.
    expect(chipWords(OPENAI, { model: "gpt-5.6-terra", effort: "minimal" })).toEqual({ name: "Terra", effort: "Minimal" });
    expect(chipWords(OPENAI, { model: "gpt-6-astra", effort: "xhigh" })).toEqual({ name: "Astra", effort: "XHigh" });
    expect(chipWords(ANTHROPIC, { model: "claude-opus-5", effort: "max" })).toEqual({ name: "Opus 5", effort: "Max" });
    expect(chipWords(ANTHROPIC, { model: "claude-sonnet-5", effort: "high" })).toEqual({ name: "Sonnet 5", effort: "High" });
    // A word one model offers and another does not is not shown for the other.
    expect(chipWords(OPENAI, { model: "gpt-6-astra", effort: "minimal" })).toEqual({ name: "Astra" });
    expect(chipWords(ANTHROPIC, { model: "claude-sonnet-5", effort: "max" })).toEqual({ name: "Sonnet 5" });
    // And the chip renders what the words say, in page 04's separator.
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    expect(visible(picker())).toBe("Astra · XHigh");
  });

  it("a model Dezfil knows no levels for reads as itself with no effort word", () => {
    modelChoice.set({ model: "an-unlisted-model", effort: "default" });
    expect(visible(picker({ models: UNKNOWN }))).toBe("an-unlisted-model");
  });
});

describe("the menu", () => {
  it("offers every model with its identity, ticks the chosen one, and offers that model's own levels", () => {
    const html = menu(OPENAI, { model: "gpt-6-astra", effort: "xhigh" });
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Model and effort"');
    expect(html.match(/data-model="[^"]+" role="menuitemradio"/g)).toHaveLength(2);
    const words = visible(html);
    for (const model of OPENAI) { expect(words).toContain(model.name); expect(words).toContain(model.id); }
    // Exactly one model is ticked, and it is the chosen one.
    expect(html.match(/data-model="[^"]+" role="menuitemradio" aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain('data-model="gpt-6-astra" role="menuitemradio" aria-checked="true"');
    // The levels are Astra's own, the provider-default entry included, and
    // Terra's "minimal" is not among them.
    expect(html).toContain('aria-label="Effort"');
    const levels = [...html.matchAll(/data-effort="([^"]+)"/g)].map((match) => match[1]);
    expect(levels).toEqual(["default", "low", "medium", "high", "xhigh"]);
    expect(html).toContain('data-effort="xhigh" role="menuitemradio" aria-checked="true"');
    expect(html.match(/data-effort="[^"]+" role="menuitemradio" aria-checked="true"/g)).toHaveLength(1);
  });

  it("the levels follow the selected model, not the instance default", () => {
    const levels = (choice: { model: string; effort: string }) =>
      [...menu(OPENAI, choice).matchAll(/data-effort="([^"]+)"/g)].map((match) => match[1]);
    expect(levels({ model: "gpt-5.6-terra", effort: "default" })).toEqual(["default", "minimal", "low", "medium", "high"]);
    expect(levels({ model: "gpt-6-astra", effort: "default" })).toEqual(["default", "low", "medium", "high", "xhigh"]);
  });

  it("a model with no levels brings no effort row at all", () => {
    const html = menu(UNKNOWN, { model: "an-unlisted-model", effort: "default" });
    expect(html).toContain('role="menuitemradio"');
    expect(html).not.toContain('aria-label="Effort"');
    expect(html).not.toContain("data-effort=");
    expect(visible(html)).not.toContain("Effort");
  });

  it("each effort level is its own row of the list, whole label and tick, like a model row", () => {
    // Seeded defect: the levels rendered as one horizontal segmented
    // control, a `radiogroup` of pills sharing the menu's width, which at
    // the pane's width cramped, truncated and overlapped six labels, as a
    // field round over the picker found. A row of the
    // list has the shape a segment does not: the list's own row class and
    // role, the label alone as its words, and the tick after it.
    const opus = ANTHROPIC[0];
    const html = menu(ANTHROPIC, { model: opus.id, effort: "high" });
    expect(html).not.toContain('role="radiogroup"');
    const rowClass = html.match(/<button[^>]*class="([^"]+)"[^>]*data-model=/)?.[1];
    expect(rowClass).toBeTruthy();
    const rows = [...html.matchAll(/<button[^>]*class="([^"]+)"[^>]*data-effort="([^"]+)"[^>]*>(.*?)<\/button>/g)];
    expect(rows.map((row) => row[2])).toEqual(opus.efforts.map((level) => level.value));
    for (const [, klass, value, inner] of rows) {
      const level = opus.efforts.find((entry) => entry.value === value);
      expect(klass, value).toContain(rowClass);
      expect(visible(inner), value).toBe(level?.label);
      // The tick is drawn on every row and shown on the current one.
      expect(inner, value).toContain("<svg");
    }
    expect(html).toContain('data-effort="high" role="menuitemradio" aria-checked="true"');
    expect(html.match(/data-effort="[^"]+" role="menuitemradio" aria-checked="true"/g)).toHaveLength(1);
  });
});

describe("a pick", () => {
  it("carries a level over only to a model that offers it", () => {
    expect(chooseModel(OPENAI, { model: "gpt-5.6-terra", effort: "high" }, "gpt-6-astra")).toEqual({ model: "gpt-6-astra", effort: "high" });
    // Terra has no "xhigh": the level returns to the provider default rather
    // than travelling as a word the new model does not offer.
    expect(chooseModel(OPENAI, { model: "gpt-6-astra", effort: "xhigh" }, "gpt-5.6-terra")).toEqual({ model: "gpt-5.6-terra", effort: "default" });
    expect(chooseModel(UNKNOWN, { model: "gpt-5.6-terra", effort: "high" }, "an-unlisted-model")).toEqual({ model: "an-unlisted-model", effort: "default" });
  });
});

describe("the states that disable it", () => {
  it("a disabled picker holds no open menu and still reads its selection", () => {
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    const html = picker({ disabled: true });
    expect(html).toContain("disabled=");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(visible(html)).toBe("Astra · XHigh");
  });
});

describe("a run's bound selection", () => {
  it("is what the chip reads while the run owns it, and it locks the control", () => {
    modelChoice.set({ model: "gpt-5.6-terra", effort: "minimal" });
    const html = picker({ bound: { model: "gpt-6-astra", effort: "xhigh" } });
    expect(visible(html)).toBe("Astra · XHigh");
    // Nothing can be picked while a run's own pair is on display: the chip
    // would otherwise offer to change what it is not showing.
    expect(html).toMatch(/data-model-picker[^>]*disabled/);
    expect(html).not.toContain('role="menu"');
  });

  it("gives way to the next message's selection once no run owns it", () => {
    modelChoice.set({ model: "gpt-5.6-terra", effort: "minimal" });
    expect(visible(picker())).toBe("Terra · Minimal");
  });

  it("reads an identity this instance no longer offers as itself", () => {
    // A run recovered from the server may be bound to something the status
    // read does not list; the record is still what it is.
    expect(visible(picker({ bound: { model: "gpt-5.6-nova", effort: "high" } }))).toBe("gpt-5.6-nova");
  });
});

describe("the words the chip uses, against the table the status read reports", () => {
  // Not a fixture: the two identities this instance actually offers, whose
  // level words genuinely differ. A shared scale would have to invent a
  // word for one of them, and this is where that would show.
  const TERRA = describeModel("openai", "gpt-5.6-terra", shipped);
  const ASTRA = describeModel("openai", "gpt-6-astra", shipped);
  const REAL = [TERRA, ASTRA];

  it("gives each model its own word, and never the other's", () => {
    expect(TERRA.efforts.map((e) => e.value)).toContain("minimal");
    expect(ASTRA.efforts.map((e) => e.value)).not.toContain("minimal");
    expect(ASTRA.efforts.map((e) => e.value)).toContain("xhigh");
    expect(TERRA.efforts.map((e) => e.value)).not.toContain("xhigh");

    modelChoice.set({ model: "gpt-5.6-terra", effort: "minimal" });
    expect(visible(picker({ models: REAL }))).toBe("Terra · Minimal");
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    expect(visible(picker({ models: REAL }))).toBe("Astra · XHigh");
  });

  it("says nothing about the level where the provider's own default was chosen", () => {
    // No word would be true of a request that sends no setting at all.
    modelChoice.set({ model: "gpt-6-astra", effort: "default" });
    expect(visible(picker({ models: REAL }))).toBe("Astra");
  });

  it("reads an identity the table does not know as itself, with no level word", () => {
    const UNKNOWN = describeModel("openai", "gpt-7-unheard", shipped);
    modelChoice.set({ model: "gpt-7-unheard", effort: "high" });
    expect(visible(picker({ models: [...REAL, UNKNOWN] }))).toBe("gpt-7-unheard");
  });
});
