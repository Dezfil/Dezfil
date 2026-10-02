import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { CanvasPane } from "./CanvasPane";
import { canvasGraph, type NodeMember } from "./graph";
import { NodePanel } from "./NodePanel";

/**
 * The pane and the node panel on Ada's workflow, read by Bo, an Editor
 * who owns datasets named like hers. His listing holds his own `roads`
 * and hers as `ada.roads`. The pane must tell the two apart and mark only
 * hers as on the canvas; the panel must read a field's columns from the
 * dataset the input names, and take an output name only in her home or
 * his own space.
 */

const draft = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
const columnsOf = vi.hoisted(() => ({ asked: [] as (string | null)[] }));
vi.mock("./use-panel-draft", () => ({
  usePanelDraft: () => ({ values: draft.values, refusals: {}, set: vi.fn(), discard: vi.fn(), sent: draft.values, setInvalid: vi.fn() }),
}));
vi.mock("../builder/drawer/use-dry-run", async (original) => ({
  ...(await original<typeof import("../builder/drawer/use-dry-run")>()),
  useDryRun: () => ({ state: "checking" }),
}));
vi.mock("../builder/drawer/use-operations", async (original) => ({
  ...(await original<typeof import("../builder/drawer/use-operations")>()),
  useTableColumns: (name: string | null) => {
    columnsOf.asked.push(name);
    return { columns: null, error: null };
  },
}));
vi.mock("./RunSection", () => ({ RunSection: () => null }));
vi.mock("./OutputFacts", () => ({ OutputFacts: () => null }));

const listed = (id: string, owner: string, typed: string, rowCount: number): TableListing =>
  ({
    id, name: typed.slice(typed.lastIndexOf(".") + 1), qualifiedName: typed, owner: { name: owner, sqlName: owner },
    rowCount, geometryColumn: "geom", geometryType: "POINT", importedAt: "2026-10-01T10:00:00Z",
  }) as unknown as TableListing;
const hers = listed("t_ada_roads", "ada", "ada.roads", 7);
const his = listed("t_bo_roads", "bo", "roads", 2);

const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "never_run", conditions: ["never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});

describe("the pane on a workflow homed in someone else's space", () => {
  for (const tables of [[his, hers], [hers, his]]) {
    it(`names the two same-named datasets apart and marks only the home's as on the canvas (${tables[0].id} first)`, () => {
      const graph = canvasGraph({
        steps: [], layout: { steps: {}, sources: { roads: { x: 0, y: 0 } } }, tables, operations: OPERATIONS, home: "ada",
      });
      const html = renderToStaticMarkup(
        <ReactFlowProvider>
          <CanvasPane graph={graph} tables={tables} operations={OPERATIONS} onAddTool={() => {}} onAddSource={() => {}}
            onAddData={() => {}} isOverCanvas={() => true} />
        </ReactFlowProvider>,
      );
      expect(html).toContain('aria-label="ada.roads, on canvas: centre the view on it"');
      expect(html).toContain('aria-label="Add roads to the canvas"');
      expect(html).not.toContain('aria-label="roads, on canvas: centre the view on it"');
    });
  }
});

describe("the node panel on a workflow homed in someone else's space", () => {
  const panel = (values: Record<string, unknown>, tables: TableListing[]) => {
    draft.values = values;
    const s = step({ id: "f", operation: "filter_rows", parameters: values, reads: typeof values.input === "string" && values.input ? [values.input] : [] });
    const graph = canvasGraph({ steps: [s], layout: { steps: {}, sources: {} }, tables, operations: OPERATIONS, home: "ada" });
    const member = graph.members.find((m) => m.id === "f") as NodeMember;
    return renderToStaticMarkup(
      <NodePanel recipeId="w1" member={member} graph={graph} operations={OPERATIONS} tables={tables} onClose={() => {}} onRemove={() => {}} />,
    );
  };

  it("reads a field's columns from the home's dataset the input names, not the reader's same-named one", () => {
    columnsOf.asked = [];
    panel({ input: "roads", field: "kind", comparison: "equals", value: "x", name: "kept" }, [his, hers]);
    expect(columnsOf.asked.filter((n) => n !== null)).toEqual(["ada.roads"]);
    columnsOf.asked = [];
    panel({ input: "bo.roads", field: "kind", comparison: "equals", value: "x", name: "kept" }, [his, hers]);
    expect(columnsOf.asked.filter((n) => n !== null)).toEqual(["roads"]);
  });

  it("takes an output name only where it lands: the home or the reader's own space", () => {
    const base = { input: "roads", field: "kind", comparison: "equals", value: "x" };
    const cys = listed("t_cy_parks", "cy", "cy.parks", 1);
    expect(panel({ ...base, name: "parks" }, [hers, cys])).not.toContain("data-name-problem");
    expect(panel({ ...base, name: "parks" }, [hers, listed("t_bo_parks", "bo", "parks", 1)])).toContain("data-name-problem");
    expect(panel({ ...base, name: "parks" }, [hers, listed("t_ada_parks", "ada", "ada.parks", 1)])).toContain("data-name-problem");
  });
});
