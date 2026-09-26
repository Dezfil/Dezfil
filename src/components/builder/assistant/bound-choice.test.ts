import shipped from "@/lib/assistant/model-catalogue.json";
import { describe, expect, it } from "vitest";
import { chooseForRequest } from "@/lib/assistant/choice";
import { PROVIDER_DEFAULT_EFFORT, describeModel, type ModelKnowledge } from "@/lib/assistant/model-knowledge";
import type { RunReceipt } from "@/lib/assistant/runs";
import { recoveredTurn } from "./assistant-turn-state";
import { boundFor, choicePayload, menuEfforts } from "./model-choice";

/**
 * What a run's own pair is, on the way in and on the way out ('s
 * provenance).
 *
 * A recovered run may be bound to something other than the next message's
 * selection — it may have been started in another tab, or before the pick
 * changed — so the pane takes the pair from the receipt rather than from
 * its own memory. And a request carries a choice only where one was made,
 * so an instance where nobody touches the picker sends exactly what it
 * sends today.
 */

/**
 * The three offered identities, taken from the same table the route judges
 * against rather than from a fixture of their own: the agreement row below
 * is only worth anything if both halves read one source. Two models offer
 * levels; the third is an identity Dezfil knows nothing about, which is
 * reported as itself offering the provider default alone.
 */
const OFFERED = ["gpt-5.6-terra", "gpt-6-astra", "gpt-7-unheard"];
const MODELS: ModelKnowledge[] = OFFERED.map((id) => describeModel("openai", id, shipped));
const LEVELLESS = "gpt-7-unheard";
const INSTANCE = { provider: "openai", model: "gpt-5.6-terra", models: OFFERED, knowledge: shipped };

const receipt = (over: Partial<RunReceipt> = {}): RunReceipt =>
  ({ id: "r1", state: "completed", text: "Done.", actions: [], incomplete: false, ...over } as RunReceipt);

describe("the pair a recovered run is bound to", () => {
  it("comes from the receipt's requested provenance, not from what the pane remembers", () => {
    const turn = recoveredTurn(receipt({
      provenance: { requested: { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: false } } },
    }));
    expect(turn.choice).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("is absent where the receipt records none, so nothing is invented for an older run", () => {
    expect(recoveredTurn(receipt()).choice).toBeUndefined();
    expect(recoveredTurn(receipt({ provenance: { reported: ["gpt-6-astra-2026-09-01"] } })).choice).toBeUndefined();
  });

  it("carries the instance's own defaults where the run took them", () => {
    // The pair is what the run is bound to whichever side supplied it; what
    // the *person* asked for is the receipt's defaulted flags, which the
    // pane does not display.
    const turn = recoveredTurn(receipt({
      provenance: { requested: { model: "gpt-5.6-terra", effort: "default", defaulted: { model: true, effort: true } } },
    }));
    expect(turn.choice).toEqual({ model: "gpt-5.6-terra", effort: "default" });
  });
});

describe("what a message request carries", () => {
  it("carries nothing at all until a pick is made", () => {
    expect(choicePayload(null)).toEqual({});
    expect(Object.keys(choicePayload(null))).toHaveLength(0);
  });

  it("carries the pick exactly as it was made, both halves", () => {
    expect(choicePayload({ model: "gpt-6-astra", effort: "xhigh" })).toEqual({ choice: { model: "gpt-6-astra", effort: "xhigh" } });
    // The provider-default entry is a real pick on a model that offers it,
    // and travels as one: the API documents it as equivalent to omission,
    // and the record then shows the person asked for it rather than the
    // instance supplying it.
    expect(choicePayload({ model: "gpt-5.6-terra", effort: "default" })).toEqual({ choice: { model: "gpt-5.6-terra", effort: "default" } });
  });

  it("sends the pair whole even for a model that offers no levels of its own", () => {
    // The pane holds a neutral level for every selection, because its chip
 // and its menu need one, and it sends what it holds: the
    // ruling gives the provider-default entry to every allowed model, so
    // there is no selection the pane must take apart before sending. The
    // route resolves this to exactly what the model alone would resolve to.
    const payload = choicePayload({ model: LEVELLESS, effort: PROVIDER_DEFAULT_EFFORT });
    expect(payload).toEqual({ choice: { model: LEVELLESS, effort: PROVIDER_DEFAULT_EFFORT } });
    const whole = chooseForRequest(payload.choice, INSTANCE);
    const alone = chooseForRequest({ model: LEVELLESS }, INSTANCE);
    expect(whole.model).toBe(alone.model);
    expect(whole.effort).toBe(alone.effort);
    // They differ in one recorded fact only: who chose the neutral level.
    expect(whole.defaulted.effort).toBe(false);
    expect(alone.defaulted.effort).toBe(true);
  });

  it("builds only payloads the documented route accepts, for every selection the menu can make", () => {
    // The two halves of this feature meet here. The pane's menu can select
    // any listed model and any level that model reports; each of those
    // selections must survive item 2's refusals, or the pick is offered and
    // then refused.
    for (const model of MODELS) {
      // What the menu can select: the levels it draws a row for, and the
      // neutral level every selection carries when it draws none.
      const rows = menuEfforts(MODELS, model.id).map((level) => level.value);
      const levels = rows.length > 0 ? rows : [PROVIDER_DEFAULT_EFFORT];
      for (const effort of levels) {
        const payload = choicePayload({ model: model.id, effort });
        const resolved = chooseForRequest(payload.choice, INSTANCE);
        expect(resolved.model, `${model.id} at ${effort}`).toBe(model.id);
        expect(resolved.effort, `${model.id} at ${effort}`).toBe(effort);
      }
    }
  });

  it("and that walk measures something, because the route does refuse payloads the menu cannot build", () => {
    // The control for the row above. Two refusals the menu can never reach:
    // a level one model has and the selected one does not, and any named
    // level on a model that has none.
    expect(() => chooseForRequest({ model: "gpt-5.6-terra", effort: "xhigh" }, INSTANCE))
      .toThrow(/does not offer the effort/);
    expect(() => chooseForRequest({ model: LEVELLESS, effort: "high" }, INSTANCE))
      .toThrow(/takes only "default"/);
  });
});

describe("the pair a submission binds its run to", () => {
  it("is the person's pick where they made one", () => {
    expect(boundFor({ model: "gpt-6-astra", effort: "xhigh" }, "gpt-5.6-terra")).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("is the instance's own default where they made none, because that is what will answer", () => {
    // The request carries nothing in this case; the display is still the
    // truth about which model the run is bound to.
    expect(boundFor(null, "gpt-5.6-terra")).toEqual({ model: "gpt-5.6-terra", effort: "default" });
    expect(choicePayload(null)).toEqual({});
  });

  it("is nothing at all before the instance has said what it offers", () => {
    expect(boundFor(null, undefined)).toBeUndefined();
  });
});
