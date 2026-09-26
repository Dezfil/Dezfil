"use client";

import { useCallback, useRef } from "react";
import type { Connection, FinalConnectionState } from "@xyflow/react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { CanvasGraph, NodeMember } from "./graph";
import { linkRefusal, memberByName, outputNameOf } from "./link-rules";
import { OUT_HANDLE, type ReadFlowEdge } from "./to-flow";
import type { RecordingEdits } from "./history-recording";
import type { EditOutcome } from "./use-recipe-edits";
import type { WorkflowRunner } from "./use-workflow-run";

/**
 * The canvas's connections: a link dragged from an output port onto an
 * input port or a node's body, a filled input's link moved to another
 * input or detached on the canvas, each under the link rules applied
 * before any edit, and each made as one edit carrying the node's whole
 * effective definition. Extracted from the canvas (the moved link
 * becomes a step here); the handlers are the library's own callbacks,
 * unchanged.
 */
export function useCanvasLinks({
  graph,
  operations,
  tables,
  runner,
  edits,
  say,
}: {
  graph: CanvasGraph;
  operations: OperationDef[];
  tables: TableListing[];
  runner: WorkflowRunner;
  edits: RecordingEdits;
  say: (text: string, tone?: "bad") => void;
}) {
  const memberOf = useCallback((id: string | null | undefined) => graph.members.find((m) => m.id === id) ?? null, [graph]);
  const refusalOf = useCallback(
    (conn: Connection): string | null => {
      const from = memberOf(conn.source);
      const to = memberOf(conn.target);
      if (!from || !to || to.kind !== "node" || !conn.targetHandle) return "Drop the link on a node's input.";
      if (runner.unsettled(to.id)) return `${to.label} is part of the run in flight. Link it once it settles.`;
      return linkRefusal({ from, to, port: conn.targetHandle, graph, operations, tables });
    },
    [graph, memberOf, operations, runner, tables],
  );
  const isValidConnection = useCallback(
    (conn: Connection | ReadFlowEdge) => {
      const from = memberOf(conn.source);
      // A drag that began on an input port is the link being moved, handled at its end.
      if (from && from.kind === "node" && conn.sourceHandle !== OUT_HANDLE) return false;
      return refusalOf(conn as Connection) === null;
    },
    [memberOf, refusalOf],
  );
  /** Set a node's input: one edit carrying the node's whole effective
   * definition. Resolves with the outcome, so a move detaches its old
   * port only once the new link is stored. A move passes the channel its
   * composite handed it, so its two edits are that step's and no edit
   * landing meanwhile joins them. */
  const setInput = useCallback(
    async (to: NodeMember, port: string, name: string | null, via: Pick<RecordingEdits, "edit"> = edits): Promise<EditOutcome> => {
      // The one boundary every link, move and detach crosses: a member of
      // the run in flight is not edited from the canvas.
      if (runner.unsettled(to.step.id)) {
        const message = `${to.label} is part of the run in flight. Link it once it settles.`;
        say(message, "bad");
        return { kind: "refused", code: "run_in_flight", message };
      }
      const effective = { ...(to.step.proposedParameters ?? to.step.parameters) };
      if (name === null) delete effective[port];
      else effective[port] = name;
      const outcome = await via.edit(to.step.id, effective);
      if (outcome.kind === "refused") say(outcome.message, "bad");
      else if (outcome.kind === "accepted") {
        const label = operations.find((o) => o.id === to.step.operation)?.inputs.find((i) => i.name === port)?.label ?? port;
        say(name ? `Linked ${name} into ${label}.${outcome.applied === "proposed" ? " Run to apply." : ""}` : `Detached ${label}.`);
      }
      return outcome;
    },
    [edits, operations, runner, say],
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      const why = refusalOf(conn);
      if (why) {
        say(why, "bad");
        return;
      }
      const from = memberOf(conn.source)!;
      const to = memberOf(conn.target) as NodeMember;
      void setInput(to, conn.targetHandle!, outputNameOf(from)!);
    },
    [memberOf, refusalOf, say, setInput],
  );
  // Dropped on a node's body rather than a port: its one input, or its first empty one.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
      // A drag that began on a filled input port is the link being taken
      // off it: dropped on another input it moves there, on
      // a node's body it takes that node's first empty input, on the
      // canvas it detaches. The rules apply before any edit.
      if (state.fromHandle?.type === "target" && state.fromHandle.id) {
        const holder = memberOf(state.fromNode.id);
        if (!holder || holder.kind !== "node") return;
        const port = state.fromHandle.id;
        const carried = holder.step.proposedParameters?.[port] ?? holder.step.parameters[port];
        if (typeof carried !== "string" || carried === "") return;
        const source = memberByName(graph, carried);
        const under = document.elementFromPoint(point.clientX, point.clientY);
        const handle = under?.closest<HTMLElement>(".react-flow__handle.target");
        const wrapper = under?.closest<HTMLElement>(".react-flow__node");
        const landed = memberOf(wrapper?.dataset.id);
        if (landed && landed.kind === "node" && landed.id !== holder.id) {
          const op = operations.find((o) => o.id === landed.step.operation);
          const effective = landed.step.proposedParameters ?? landed.step.parameters;
          const toPort =
            handle?.dataset.handleid ??
            (op?.inputs.length === 1 ? op.inputs[0].name : op?.inputs.find((i) => typeof effective[i.name] !== "string" || effective[i.name] === "")?.name);
          if (!toPort) {
            say("Drop it on one of the input ports.", "bad");
            return;
          }
          if (!source) {
            say(`${carried} is not on the canvas.`, "bad");
            return;
          }
          const why = linkRefusal({ from: source, to: landed, port: toPort, graph, operations, tables });
          if (why) {
            say(why, "bad");
            return;
          }
          // The move is one step in the record: its two edits are held in
          // one scope and recorded as one, after both have landed.
          void edits.composite(async (scoped) => {
            const outcome = await setInput(landed, toPort, carried, scoped);
            if (outcome.kind === "accepted") await setInput(holder, port, null, scoped);
          });
          return;
        }
        if (landed && landed.id === holder.id) return; // let go where it was: nothing changes
        void setInput(holder, port, null);
        return;
      }
      const from = memberOf(state.fromNode.id);
      if (!from) return;
      // Let go on a port the rules refuse: the library names the port, and
      // the refusal is said for it.
      if (state.toNode && state.toHandle?.id && state.toHandle.type === "target") {
        const to = memberOf(state.toNode.id);
        if (to && to.kind === "node") {
          const why = linkRefusal({ from, to, port: state.toHandle.id, graph, operations, tables });
          say(why ?? "Drop the link on a node's input.", "bad");
          return;
        }
      }
      const under = document.elementFromPoint(point.clientX, point.clientY)?.closest("[data-node]");
      const wrapper = under?.closest(".react-flow__node") as HTMLElement | null;
      const toId = wrapper?.dataset.id;
      const to = memberOf(toId);
      if (!to || to.kind !== "node") return;
      const op = operations.find((o) => o.id === to.step.operation);
      if (!op || op.inputs.length === 0) {
        say(`${to.label} reads what its query names. Change the query instead.`, "bad");
        return;
      }
      const effective = to.step.proposedParameters ?? to.step.parameters;
      const port = op.inputs.length === 1 ? op.inputs[0] : op.inputs.find((i) => typeof effective[i.name] !== "string" || effective[i.name] === "");
      if (!port) {
        say("Drop it on one of the input ports.", "bad");
        return;
      }
      const why = runner.unsettled(to.id)
        ? `${to.label} is part of the run in flight. Link it once it settles.`
        : linkRefusal({ from, to, port: port.name, graph, operations, tables });
      if (why) {
        say(why, "bad");
        return;
      }
      void setInput(to, port.name, outputNameOf(from)!);
    },
    [edits, graph, memberOf, operations, runner, say, setInput, tables],
  );
  // A filled input's link dragged to another input moves it; dropped on
  // the canvas, it detaches. A refused move keeps the original.
  const reconnected = useRef(false);
  const onReconnectStart = useCallback(() => {
    reconnected.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge: ReadFlowEdge, conn: Connection) => {
      reconnected.current = true;
      const why = refusalOf(conn);
      if (why) {
        say(why, "bad");
        return;
      }
      const to = memberOf(conn.target) as NodeMember;
      const from = memberOf(conn.source)!;
      const old = oldEdge.data?.edge;
      const same = old && old.to === conn.target && old.attachment.kind === "port" && old.attachment.port === conn.targetHandle;
      if (same) return;
      // Moving within one node: clear the old port and set the new in one edit.
      const effective = { ...(to.step.proposedParameters ?? to.step.parameters) };
      if (old && old.to === to.id && old.attachment.kind === "port") delete effective[old.attachment.port];
      effective[conn.targetHandle!] = outputNameOf(from)!;
      // One step for the move, in this road too.
      void edits.composite(async (scoped) => {
        const outcome = await scoped.edit(to.step.id, effective);
        if (outcome.kind === "refused") {
          say(outcome.message, "bad");
          return;
        }
        if (outcome.kind === "accepted" && old && old.to !== to.id && old.attachment.kind === "port") {
          // Moved to another node: the old reader lets go.
          const oldReader = memberOf(old.to);
          if (oldReader && oldReader.kind === "node") await setInput(oldReader, old.attachment.port, null, scoped);
        }
      });
    },
    [edits, memberOf, refusalOf, say, setInput],
  );
  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: ReadFlowEdge, _handle: unknown, state: FinalConnectionState) => {
      if (reconnected.current || state.isValid) return;
      // Let go on the canvas: detach.
      const e = edge.data?.edge;
      const to = memberOf(edge.target);
      if (!e || !to || to.kind !== "node" || e.attachment.kind !== "port") return;
      void setInput(to, e.attachment.port, null);
    },
    [memberOf, setInput],
  );

  return { isValidConnection, onConnect, onConnectEnd, onReconnectStart, onReconnect, onReconnectEnd };
}
