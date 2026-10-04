import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { actionEffects } from "@/lib/assistant/action-metadata";
import type { RecoveryAction } from "@/lib/assistant/runs";
import { requiresRefresh } from "./assistant-event-metadata";
import { AssistantConfirmation } from "./AssistantConfirmation";

describe("pane consumes declared metadata", () => {
  it("refreshes for a formerly unlisted duplicate and any new effect, without an opcode list", () => {
    const tool = buildTools().find((entry) => entry.name === "duplicate_layer")!;
    expect(requiresRefresh([{ id: "copy", tool: tool.name, status: "succeeded", effects: actionEffects(tool, { id: "source" }, { id: "copy" }) }])).toBe(true);
    expect(requiresRefresh([{ id: "future", tool: "a_new_operation", status: "uncertain", effects: { readOnly: false, writes: [{ resource: "layers", ids: ["layer"], collection: false }] } }])).toBe(true);
  });
  it("keeps read-only POSTs, plans and refused mutations out of refresh", () => {
    for (const name of ["run_sql", "compute_fill", "run_recipe"]) {
      const tool = buildTools().find((entry) => entry.name === name)!;
      expect(requiresRefresh([{ id: name, tool: name, status: "succeeded", effects: actionEffects(tool, { plan: true }) }])).toBe(false);
    }
    const action: RecoveryAction = { id: "a", tool: "update_layer", status: "refused", effects: { readOnly: false, writes: [{ resource: "layers", ids: ["l"], collection: false }] } };
    expect(requiresRefresh([action])).toBe(false);
    expect(requiresRefresh([{ ...action, status: "attempted" }])).toBe(false);
    expect(requiresRefresh([{ ...action, status: "accepted", jobId: "job" }])).toBe(true);
  });
  it("renders target and consequence for every gate without displaying the opcode", () => {
    const gates = buildTools().filter((tool) => tool.confirm || tool.confirmWhen);
    // Membership changes, self-departure and the three transfers are gates.
    expect(gates).toHaveLength(25);
    for (const tool of gates) {
      const confirmation = { target: tool.confirmation!.target.replace("{target}", "Original (id)"), consequence: tool.confirmation!.consequence };
      const html = renderToStaticMarkup(<AssistantConfirmation pending={{ id: "pending", runId: "run", tool: tool.name, args: {}, confirmation }} promptId="prompt" busy={false} resolve={() => {}} />);
      expect(html).toContain(confirmation.target);
      expect(html).toContain(confirmation.consequence);
      expect(html).not.toContain(tool.name);
      expect(html).toContain('aria-labelledby="prompt"');
    }
  });
});
