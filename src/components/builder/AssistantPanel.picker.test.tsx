import shipped from "@/lib/assistant/model-catalogue.json";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeModel } from "@/lib/assistant/model-knowledge";
import { emptyTurn, type Status } from "./assistant/assistant-turn-state";
import type { TurnPhase } from "./assistant/turn-phase";
import { modelChoice } from "./assistant/model-choice-store";

/**
 * Where the picker stands in the pane: page 04's five states, in both of
 * the pane's forms, with the model line it replaces.
 *
 * The turn hook is replaced so the status and the phase are the test's to
 * set; everything below it is the product's own components. The two
 * referenced widths are layout, so they belong to the browser pass; this
 * decides what the markup says.
 */

const hook = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("./assistant/use-assistant-turn", () => ({ useAssistantTurn: () => hook.state }));

const { AssistantPanel } = await import("./AssistantPanel");

const SEVERAL = ["gpt-5.6-terra", "gpt-6-astra"].map((id) => describeModel("openai", id, shipped));
const ONE = [describeModel("openai", "gpt-5.6-terra", shipped)];
const NO_EFFORT = ["gpt-5.6-terra", "an-unlisted-model"].map((id) => describeModel("openai", id, shipped));

const enabled = (models: typeof SEVERAL): Status =>
  ({ enabled: true, provider: "openai", model: "gpt-5.6-terra", stepBudget: 8, models });

function pane(options: { status: Status; phase?: TurnPhase; showTitle: boolean; bound?: { model: string; effort: string } }) {
  const phase = options.phase ?? "idle";
  hook.state = {
    status: options.status, statusFailed: false, setStatusFailed: () => {}, setStatusAttempt: () => {},
    turns: [], input: "", setInput: () => {}, busy: phase === "executing", phase,
    streaming: false, announcements: [], live: {
      ...emptyTurn(),
      ...(options.bound ? { choice: options.bound } : {}),
      ...(phase === "parked" ? { pending: { id: "p1", runId: "r1", tool: "delete_table", args: {}, confirmation: { target: "Delete parks_raw?", consequence: "Layers stop drawing." } } } : {}),
    },
    error: null, setError: () => {}, submit: () => {}, resolve: () => {}, recoveryId: null,
    recover: () => {}, stop: () => {}, availablePending: [], markInserted: () => {}, submitText: () => {},
  };
  return renderToStaticMarkup(
    <AssistantPanel onMutate={() => {}} layerDataDownloads={{} as never} showTitle={options.showTitle} />,
  );
}

const both = [true, false] as const;
const form = (showTitle: boolean) => (showTitle ? "the titled panel" : "the pane");

beforeEach(() => modelChoice.resetForTests());

describe("page 04's five states, in both of the pane's forms", () => {
  it("several models: the picker stands in the composer's footer and the model line is gone", () => {
    for (const showTitle of both) {
      const html = pane({ status: enabled(SEVERAL), showTitle });
      expect(html, form(showTitle)).toContain("data-model-picker");
      // The picker sits inside the composer's form, not above the transcript.
      expect(html.indexOf("data-model-picker"), form(showTitle)).toBeGreaterThan(html.indexOf("data-transcript"));
      expect(html, form(showTitle)).toContain('aria-label="Ask the assistant"');
      // The model line and the title's model chip are both gone: the
      // control already names the model.
      expect(html, form(showTitle)).not.toContain("gpt-5.6-terra");
      expect(html.match(/Terra/g), form(showTitle)).toHaveLength(1);
    }
  });

  it("one model only: no picker, and the pane is exactly what ships today", () => {
    for (const showTitle of both) {
      const html = pane({ status: enabled(ONE), showTitle });
      expect(html, form(showTitle)).not.toContain("data-model-picker");
      // The quiet model line stays, in each form's own place.
      expect(html, form(showTitle)).toContain("gpt-5.6-terra");
      expect(html, form(showTitle)).not.toContain("Terra<");
    }
  });

  it("an instance older than the picker reports no list and keeps today's pane", () => {
    const status = { enabled: true, provider: "openai", model: "gpt-5.6-terra", stepBudget: 8 } as Status;
    for (const showTitle of both) {
      const html = pane({ status, showTitle });
      expect(html, form(showTitle)).not.toContain("data-model-picker");
      expect(html, form(showTitle)).toContain("gpt-5.6-terra");
    }
  });

  it("no effort setting: the chosen model brings no effort row and no effort word", () => {
    modelChoice.set({ model: "an-unlisted-model", effort: "default" });
    for (const showTitle of both) {
      const html = pane({ status: enabled(NO_EFFORT), showTitle });
      expect(html, form(showTitle)).toContain("data-model-picker");
      expect(html, form(showTitle)).toContain("an-unlisted-model");
      expect(html, form(showTitle)).not.toContain("·");
    }
  });

  it("a turn in flight and a confirmation waiting each disable the picker, with no menu open", () => {
    for (const phase of ["executing", "parked"] as const) {
      for (const showTitle of both) {
        const html = pane({ status: enabled(SEVERAL), phase, showTitle });
        const where = `${phase}, ${form(showTitle)}`;
        expect(html, where).toContain("data-model-picker");
        expect(html, where).toMatch(/data-model-picker[^>]*disabled/);
        expect(html, where).toContain('aria-expanded="false"');
        expect(html, where).not.toContain('role="menu"');
        // The state the disabling comes from is really the drawn one.
        expect(html, where).toContain('data-phase="' + phase + '"');
        expect(html, where).toContain('data-slot-control="stop"');
      }
    }
  });
});

describe("what the picker reads while a run owns it", () => {
  const BOUND = { model: "gpt-6-astra", effort: "xhigh" };
  const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("the executing state and the confirmation state each show the run's pair, disabled, no menu", () => {
    modelChoice.set({ model: "gpt-5.6-terra", effort: "minimal" });
    for (const phase of ["executing", "parked"] as const) {
      const html = pane({ status: enabled(SEVERAL), phase, showTitle: false, bound: BOUND });
      expect(html, phase).toContain('data-phase="' + phase + '"');
      expect(words(html), phase).toContain("Astra · XHigh");
      expect(words(html), phase).not.toContain("Terra");
      expect(html, phase).toMatch(/data-model-picker[^>]*disabled/);
      expect(html, phase).not.toContain('role="menu"');
    }
  });

  it("at rest the picker is the next message's selection again", () => {
    modelChoice.set({ model: "gpt-5.6-terra", effort: "minimal" });
    const html = pane({ status: enabled(SEVERAL), showTitle: false });
    expect(words(html)).toContain("Terra · Minimal");
    expect(words(html)).not.toContain("Astra");
    expect(html).not.toMatch(/data-model-picker[^>]*disabled/);
  });
});
