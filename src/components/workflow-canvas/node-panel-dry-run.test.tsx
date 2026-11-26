import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/operations/catalog";
import type { DryRunGate, DryRunRequest } from "../builder/drawer/use-dry-run";
import { NodePanel } from "./NodePanel";
import type { NodeMember } from "./graph";

/**
 * The canvas's dry run binds like the run will: a node's parameters are
 * the workflow's, written in its SQL home with its declared outputs, so the
 * preview asks in the workflow's context rather than the caller's console.
 * On a workflow someone else owns, a plain name is then the home's dataset,
 * as the run reads it, not the caller's own of the same name.
 */

const asked = vi.hoisted(() => ({ request: undefined as DryRunRequest | null | undefined, gate: { state: "checking" } as DryRunGate }));
vi.mock("../builder/drawer/use-dry-run", async (original) => ({
  ...(await original<typeof import("../builder/drawer/use-dry-run")>()),
  useDryRun: (request: DryRunRequest | null) => {
    asked.request = request;
    return asked.gate;
  },
}));
const sql = { sql: "SELECT * FROM roads", name: "roads_out" };
vi.mock("./use-panel-draft", () => ({
  usePanelDraft: () => ({ values: sql, refusals: {}, set: vi.fn(), discard: vi.fn(), sent: sql, setInvalid: vi.fn() }),
}));
vi.mock("./RunSection", () => ({ RunSection: () => null }));
vi.mock("./OutputFacts", () => ({ OutputFacts: () => null }));

const member = {
  kind: "node", id: "s1", label: "SQL", group: null, symbol: "code", outputName: "roads_out",
  state: { word: "never run", tone: "muted", badge: null }, run: null, disclosure: "", ports: [], sql: true,
  step: {
    id: "s1", ordinal: 0, operation: "sql_step", parameters: sql, proposedParameters: null, output: null,
    condition: "never run", conditions: [], causes: [], reads: ["roads"],
  },
} as unknown as NodeMember;

describe("the node panel's dry run", () => {
  it("asks in the workflow's context", () => {
    renderToStaticMarkup(
      <NodePanel recipeId="w1" member={member} graph={{ members: [member], edges: [], presentSourceCount: 0 }}
        operations={OPERATIONS} tables={[]} onClose={() => {}} onRemove={() => {}} />,
    );
    expect(asked.request).toMatchObject({ operation: "sql_step", writtenIn: { kind: "workflow", id: "w1" } });
  });

  it("names the preview's geometry kind as a plain word", () => {
    const draw = (geometryType: string | null) => {
      asked.gate = { state: "ready", preview: { rowCount: 1204, geometry: "classified", geometryType, warnings: [] } };
      const html = renderToStaticMarkup(
        <NodePanel recipeId="w1" member={member} graph={{ members: [member], edges: [], presentSourceCount: 0 }}
          operations={OPERATIONS} tables={[]} onClose={() => {}} onRemove={() => {}} />,
      );
      asked.gate = { state: "checking" };
      return /data-preview-line[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1].replace(/<[^>]+>/g, "");
    };
    expect(draw("MULTIPOLYGON")).toBe("1,204 rows · Polygons");
    expect(draw("POINT+POLYGON")).toBe("1,204 rows · Mixed");
    expect(draw(null)).toBe("1,204 rows · Geometry");
  });
});
