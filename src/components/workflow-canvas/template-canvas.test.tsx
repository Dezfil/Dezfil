import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { CanvasPane } from "./CanvasPane";
import { CanvasResults } from "./CanvasResults";
import { canvasGraph, type NodeMember, type SourceMember } from "./graph";
import { NodePanel } from "./NodePanel";
import { OutputFacts } from "./OutputFacts";
import { SourcePanel } from "./SourcePanel";
import { TemplateCanvas, type TemplateCanvasSeam } from "./template-canvas";
import type { WorkflowRunner } from "./use-workflow-run";
import { VIEW_ONLY_REASON, ViewOnly } from "./view-only";

/**
 * A template's workflow example on its own page: no one's recipe, its
 * datasets no one's listing. The pane's place holds the template's How
 * it's made; the results band is not drawn; a source's and a node's panel
 * ask nothing of the dataset roads (no facts, columns or dry run) and say
 * what the page handed over; a node's output names the template's result,
 * never a run, and offers no map. On any other canvas each stays as
 * shipped.
 */

const asked = vi.hoisted(() => ({ dryRun: [] as unknown[], columns: [] as (string | null)[], facts: [] as (string | null)[] }));
vi.mock("../builder/drawer/use-dry-run", async (original) => ({
  ...(await original<typeof import("../builder/drawer/use-dry-run")>()),
  useDryRun: (request: unknown) => {
    asked.dryRun.push(request);
    return { state: "checking" };
  },
}));
vi.mock("../builder/drawer/use-operations", async (original) => ({
  ...(await original<typeof import("../builder/drawer/use-operations")>()),
  useTableColumns: (name: string | null) => {
    asked.columns.push(name);
    return { columns: null, error: null };
  },
}));
vi.mock("./use-table-facts", () => ({
  useTableFacts: (name: string | null) => {
    asked.facts.push(name);
    return { state: "reading" };
  },
}));
const draft = { input: "stations", field: "riders", comparison: "greater_than", value: "100", name: "busy_stations" };
vi.mock("./use-panel-draft", () => ({
  usePanelDraft: () => ({ values: draft, refusals: {}, set: vi.fn(), discard: vi.fn(), sent: draft, setInvalid: vi.fn() }),
}));
vi.mock("./ResultsBand", () => ({ ResultsBand: () => <div data-results-band /> }));
vi.mock("./RunSection", () => ({ RunSection: () => null }));
vi.mock("../AddToMapDialog", () => ({ AddToMapDialog: () => null, tableSubject: (subject: string | null) => subject }));

const seam: TemplateCanvasSeam = {
  read: async () => { throw new Error("not read here"); },
  pane: <aside data-template-panel>How it&apos;s made</aside>,
};

const listed = (id: string, name: string, rowCount: number, geometryType: string): TableListing =>
  ({
    id, name, qualifiedName: name, owner: { name: "Template", sqlName: "template" }, rowCount, geometryColumn: "geom",
    geometryType, source: "template", importedAt: null,
  }) as unknown as TableListing;
const STATIONS = listed("template.busy-stations.1.dataset.stations", "stations", 6, "POINT");
const BUSY = listed("template.busy-stations.1.result.step-busy", "busy_stations", 4, "POINT");
const RINGS = listed("template.busy-stations.1.result.step-rings", "station_rings", 4, "POLYGON");
const TABLES = [STATIONS, BUSY, RINGS];

const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "current", conditions: ["current"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});
const MARK = { template: "busy-stations", version: 1 };
const STEPS = [
  step({ id: "step-busy", operation: "filter_rows", parameters: draft,
    output: { id: BUSY.id, name: "busy_stations" }, reads: ["stations"], templateResult: MARK }),
  step({ id: "step-rings", ordinal: 1, operation: "buffer", parameters: { input: "busy_stations", distance: 250, name: "station_rings" },
    output: { id: RINGS.id, name: "station_rings" }, reads: ["busy_stations"], templateResult: MARK }),
];
const graph = canvasGraph({ steps: STEPS, layout: { steps: {}, sources: {} }, tables: TABLES, operations: OPERATIONS, home: null });
const node = (id: string) => graph.members.find((m) => m.id === id) as NodeMember;
const source = graph.members.find((m) => m.kind === "source") as SourceMember;

/** A canvas as the page draws it: view-only, and a template's or not. */
function draw(node: ReactNode, template: boolean) {
  return renderToStaticMarkup(
    <ViewOnly value runs={false}>
      <TemplateCanvas value={template ? seam : null}>
        <ReactFlowProvider>{node}</ReactFlowProvider>
      </TemplateCanvas>
    </ViewOnly>,
  );
}

describe("a template's canvas", () => {
  it("holds the template's How it's made in the pane's place", () => {
    const pane = (template: boolean) => draw(
      <CanvasPane graph={graph} tables={TABLES} operations={OPERATIONS} onAddTool={() => {}} onAddSource={() => {}}
        onAddData={() => {}} isOverCanvas={() => false} lockReason={VIEW_ONLY_REASON} />, template);
    const html = pane(true);
    expect(html).toContain("data-template-panel");
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("Tools");
    const shipped = pane(false);
    expect(shipped).not.toContain("data-template-panel");
    expect(shipped).toContain("Sources");
  });

  it("draws no results band", () => {
    const runner = { state: { runs: [], active: null } } as unknown as WorkflowRunner;
    const band = (template: boolean) => draw(
      <CanvasResults graph={graph} selected={null} tables={TABLES} operations={OPERATIONS} runner={runner}
        hostHeight={600} onHeight={() => {}} onSelectNode={() => {}} onListingStale={() => {}} />, template);
    expect(band(true)).toBe("");
    expect(band(false)).toContain("data-results-band");
  });

  it("reads none of a source's facts and says the dataset is the template's", () => {
    asked.facts = [];
    const html = draw(<SourcePanel member={source} graph={graph} onSelect={() => {}} onClose={() => {}} onRemove={() => {}}
      lockReason={VIEW_ONLY_REASON} />, true);
    expect(asked.facts).toEqual([null]);
    expect(html).toContain("this template");
    expect(html).toContain(">6<");
    expect(html).not.toContain('aria-label="Columns"');
    expect(html).not.toContain("data-open-explorer");
    asked.facts = [];
    const shipped = draw(<SourcePanel member={source} graph={graph} onSelect={() => {}} onClose={() => {}} onRemove={() => {}}
      lockReason={VIEW_ONLY_REASON} />, false);
    expect(asked.facts).toEqual(["stations"]);
    expect(shipped).toContain('aria-label="Columns"');
    expect(shipped).toContain("data-open-explorer");
  });

  it("tries no node and reads no columns of its input, and drops the preview of a run", () => {
    asked.dryRun = [];
    asked.columns = [];
    const panel = (template: boolean) => draw(<NodePanel recipeId="template.busy-stations.1.workflow" member={node("step-busy")}
      graph={graph} operations={OPERATIONS} tables={TABLES} onClose={() => {}} onRemove={() => {}} lockReason={VIEW_ONLY_REASON} />, template);
    const html = panel(true);
    expect(asked.dryRun.every((request) => request === null)).toBe(true);
    expect(asked.columns.every((name) => name === null)).toBe(true);
    expect(html).not.toContain("data-preview");
    asked.dryRun = [];
    asked.columns = [];
    const shipped = panel(false);
    expect(asked.dryRun.some((request) => request !== null)).toBe(true);
    expect(asked.columns).toContain("stations");
    expect(shipped).toContain("data-preview");
  });
});

describe("a node's output on a template's canvas", () => {
  const facts = (template: boolean, s: WorkflowStep = STEPS[1]) =>
    draw(<OutputFacts step={s} outputName={s.output!.name!} table={RINGS} />, template);

  it("names the template's result, never a run, and offers no map", () => {
    const html = facts(true);
    expect(html).toContain("the template&#x27;s result");
    expect(html).not.toContain("no successful run");
    expect(html).not.toContain("data-add-to-map");
    expect(html).toContain(">4<");
  });

  it("keeps the shipped row and the map's door on any other canvas", () => {
    const plain = { ...STEPS[1], templateResult: null };
    const html = facts(false, plain);
    expect(html).toContain("no successful run");
    expect(html).toContain("data-add-to-map");
  });
});

describe("a copied workflow's node panel", () => {
  it("says an output that came with the copy was copied from the template, and offers the map", () => {
    const html = draw(<OutputFacts step={STEPS[1]} outputName="station_rings" table={RINGS} />, false);
    expect(html).toContain('data-last-run="true">copied from the template<');
    expect(html).not.toContain("the template&#x27;s result");
    expect(html).toContain("data-add-to-map");
  });

  it("says so in the panel the copy's canvas opens", () => {
    const html = draw(<NodePanel recipeId="recipe-9" member={node("step-rings")} graph={graph} operations={OPERATIONS}
      tables={TABLES} onClose={() => {}} onRemove={() => {}} />, false);
    expect(html).toContain('data-last-run="true">copied from the template<');
  });

  it("names a run once the first run replaced the copied result", () => {
    const ran = { ...STEPS[1], templateResult: null, lastSuccessAt: new Date(Date.now() - 60_000).toISOString() };
    const html = draw(<OutputFacts step={ran} outputName="station_rings" table={RINGS} />, false);
    expect(html).not.toContain("copied from the template");
    expect(html).not.toContain("no successful run");
  });
});
