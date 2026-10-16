import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/operations/catalog";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph } from "./graph";
import type { RecipeCoordinator } from "./use-recipe-edits";
import type { WorkflowRunner } from "./use-workflow-run";
import type { WorkflowAssistant } from "./WorkflowAssistantHost";
import { WorkflowCanvas } from "./WorkflowCanvas";
import type { WorkflowStage } from "./WorkflowStage";

/**
 * The stage's controls come before the canvas's nodes in the page's
 * order, which is the order Tab walks: from the last control, the lock,
 * the next press lands on a node rather than leaving the canvas and
 * reaching one only by wrapping past the page's end. The controls are
 * positioned over the canvas, so their place in the order moves nothing
 * on screen.
 *
 * The canvas is drawn on the server with its real stage. Only the flow
 * library's host is a stand-in, since the library adds its nodes once it
 * is mounted in a browser: like the library, the stand-in draws every
 * node, focusable, inside its one root element, so whatever the canvas
 * places before or after that root is before or after every node. The
 * pane, the results band and the furniture are left out; the order
 * between the stage and the nodes is what is held here, and the markup's
 * order is the document's.
 */

vi.mock("./CanvasPane", () => ({ CanvasPane: () => null }));
vi.mock("./CanvasResults", () => ({ CanvasResults: () => null }));
vi.mock("./CanvasGrid", () => ({ CanvasGrid: () => null }));
vi.mock("./CanvasFurniture", async (original) => ({
  ...(await original<typeof import("./CanvasFurniture")>()),
  CanvasFurniture: () => null,
}));
vi.mock("@xyflow/react", async (original) => {
  const flow = await original<typeof import("@xyflow/react")>();
  const updateNodeInternals = () => {};
  return {
    ...flow,
    useUpdateNodeInternals: () => updateNodeInternals,
    ReactFlow: function FlowHost({ nodes, children }: ComponentProps<typeof WorkflowStage>) {
      return (
        <div className="react-flow" aria-label="Workflow canvas">
          {nodes?.map((node) => <div key={node.id} className="react-flow__node" tabIndex={0} data-id={node.id} />)}
          {children}
        </div>
      );
    },
  };
});

const step = (id: string, ordinal: number): WorkflowStep => ({
  id, ordinal, operation: "sql_step", parameters: { sql: "SELECT 1", name: id }, proposedParameters: null,
  output: null, reads: [], condition: "never_run", conditions: ["never_run"], causes: [], missingInputs: [],
  inputs: [], latestAttempt: null, lastSuccessAt: null,
});
const layout = { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "saved" };
const graph = canvasGraph({ steps: [step("a", 0), step("b", 1)], layout, tables: [], operations: OPERATIONS, home: null });
const runner = {
  state: { runs: [], active: null, phase: "idle", ended: null, readFailure: null },
  unsettled: () => false,
} as unknown as WorkflowRunner;
const edits = {
  owned: () => ({}), setRetryPorts: () => {},
  document: { subscribe: () => () => {}, snapshot: () => false },
} as unknown as RecipeCoordinator;
const assistant = { open: false, band: "two" } as unknown as WorkflowAssistant;

function draw(): string {
  return renderToStaticMarkup(
    <WorkflowCanvas
      id="w" graph={graph} layout={layout} tables={[]} operations={OPERATIONS}
      onSaveState={() => {}} onEditState={() => {}} onHistory={() => {}} onLayoutWritten={() => {}}
      edits={edits} onAddData={() => {}} addSourceRequest={null} runner={runner}
      onRunFrom={() => {}} onListingStale={() => {}} whisper={null} assistant={assistant} recipeName="Order"
    />,
  );
}

describe("the canvas's Tab order", () => {
  it("puts the stage's controls, the lock last among them, before the first node", () => {
    const html = draw();
    const controls = html.indexOf('aria-label="Canvas controls"');
    const lock = html.indexOf('aria-label="Lock canvas"');
    const node = html.indexOf('class="react-flow__node"');
    expect(controls, "the stage's controls are drawn").toBeGreaterThan(-1);
    expect(lock, "the lock is drawn").toBeGreaterThan(controls);
    expect(node, "a node is drawn").toBeGreaterThan(-1);
    expect(lock, "the lock precedes the first node in the page's order").toBeLessThan(node);
  });
});
