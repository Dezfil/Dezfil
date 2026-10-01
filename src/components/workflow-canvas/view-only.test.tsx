import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { PERMISSION_REFUSAL } from "@/lib/auth/reach";
import { CanvasNotices } from "./CanvasNotices";
import { CanvasPane } from "./CanvasPane";
import { CanvasSaveStatus } from "./CanvasSaveStatus";
import { CanvasStage } from "./CanvasStage";
import { HeaderHistory } from "./HeaderHistory";
import { RunDock } from "./RunDock";
import { RunSection } from "./RunSection";
import { canvasLock } from "./use-canvas-lock";
import { VIEW_ONLY_REASON, ViewOnly } from "./view-only";
import type { WorkflowRunner } from "./use-workflow-run";
import type { WorkflowAssistant } from "./WorkflowAssistantHost";

/**
 * The workflow canvas for a Viewer: the drawn view-only canvas. The lock is
 * engaged with no way to unlock it, the editing controls are gone (Undo,
 * Redo, Arrange, the note tool, the lock, Add data, Run), a "View only"
 * chip stands where the save status appears, and the view interactions
 * stay (zoom, fit, the view toggle, the minimap). An Editor's canvas is the
 * shipped one.
 */

const runner = {
  state: { active: null, phase: "idle", ended: null, readFailure: null, overlaid: false },
  cancel: async () => {},
} as unknown as WorkflowRunner;
const door = { open: false, toggle: () => {}, band: "none" } as unknown as WorkflowAssistant;

function asViewer(node: React.ReactNode, viewOnly = true) {
  return renderToStaticMarkup(
    <ViewOnly value={viewOnly}>
      <ReactFlowProvider>{node}</ReactFlowProvider>
    </ViewOnly>,
  );
}

describe("the view-only canvas", () => {
  it("says the API's own permission refusal as the reason nothing edits", () => {
    expect(VIEW_ONLY_REASON).toBe(PERMISSION_REFUSAL);
  });

  it("holds the lock engaged with no unlock for a Viewer, and leaves the lock the Editor's to toggle", () => {
    expect(canvasLock(true, false)).toEqual({ locked: true, reason: VIEW_ONLY_REASON, canToggle: false });
    expect(canvasLock(true, true)).toEqual({ locked: true, reason: VIEW_ONLY_REASON, canToggle: false });
    expect(canvasLock(false, false)).toEqual({ locked: false, reason: null, canToggle: true });
    expect(canvasLock(false, true).canToggle).toBe(true);
  });

  it("keeps the view controls on the stage and drops Arrange, the note tool and the lock", () => {
    const stage = (viewOnly: boolean) => asViewer(
      <CanvasStage view="full" onView={() => {}} onArrange={() => {}} canArrange onNoteTool={() => {}}
        onMinimap={() => {}} onLock={() => {}} locked={viewOnly} />,
      viewOnly,
    );
    const viewer = stage(true);
    for (const kept of ["Zoom in", "Zoom out", "Fit to view", "data-minimap-toggle"]) expect(viewer).toContain(kept);
    expect(viewer).not.toContain("data-arrange");
    expect(viewer).not.toContain("data-note-tool");
    expect(viewer).not.toContain("data-lock");
    const editor = stage(false);
    expect(editor).toContain("data-arrange");
    expect(editor).toContain("data-note-tool");
    expect(editor).toContain("data-lock");
  });

  it("offers no unlock in the notices", () => {
    const viewer = asViewer(<CanvasNotices notice={null} locked onUnlock={() => {}} />);
    expect(viewer).not.toContain("data-unlock");
    expect(viewer).not.toContain("unlock");
    expect(asViewer(<CanvasNotices notice={null} locked onUnlock={() => {}} />, false)).toContain("data-unlock");
  });

  it("stands a View only chip where the save status appears", () => {
    expect(asViewer(<CanvasSaveStatus whisper={null} />)).toContain("View only");
    expect(asViewer(<CanvasSaveStatus whisper={null} />, false)).not.toContain("View only");
  });

  it("drops Add data and the lock's banner from the pane, keeping its sources and tools", () => {
    const pane = (viewOnly: boolean) => asViewer(
      <CanvasPane graph={{ members: [], edges: [], presentSourceCount: 0 }} tables={[]} operations={[]}
        onAddTool={() => {}} onAddSource={() => {}} onAddData={() => {}} isOverCanvas={() => false}
        lockReason={viewOnly ? VIEW_ONLY_REASON : null} />,
      viewOnly,
    );
    const viewer = pane(true);
    expect(viewer).toContain("Sources");
    expect(viewer).toContain("Tools");
    expect(viewer).not.toContain("Add data");
    expect(viewer).not.toContain("data-pane-locked");
    expect(pane(false)).toContain("Add data");
  });

  it("drops Run all from the header's run chrome", () => {
    const dock = (viewOnly: boolean) => asViewer(
      <RunDock runner={runner} refusal={null} onRunAll={() => {}} onDismissRefusal={() => {}} />, viewOnly);
    expect(dock(true)).not.toContain("data-run-action");
    expect(dock(false)).toContain("data-run-action");
  });

  it("drops Undo and Redo from the header and keeps the assistant's door", () => {
    const history = { canUndo: true, canRedo: false, reason: null, press: () => {}, seal: () => {} };
    const viewer = asViewer(<HeaderHistory history={history} assistant={door} />);
    expect(viewer).not.toContain("data-undo");
    expect(viewer).not.toContain("data-redo");
    expect(viewer).toContain("Assistant");
    const editor = asViewer(<HeaderHistory history={history} assistant={door} />, false);
    expect(editor).toContain("data-undo");
    expect(editor).toContain("data-redo");
  });

  it("drops a node's Run section", () => {
    const member = { id: "s1", kind: "node", step: { id: "s1", output: null } } as never;
    expect(asViewer(<RunSection member={member} graph={{ members: [], edges: [], presentSourceCount: 0 }} />)).toBe("");
  });
});
