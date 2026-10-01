"use client";

import { Button } from "../ui/Button";
import { PlayIcon } from "../ui/icons";
import type { CanvasGraph, NodeMember } from "./graph";
import { downstreamOf } from "./node-panel-model";
import { useRunActions, useRunner } from "./run-context";
import { useViewOnly } from "./view-only";
import styles from "./WorkflowCanvas.module.css";

/**
 * The panel's Run section: Run this node (or Run again once it has
 * produced a dataset) runs the node alone, as its own run, asking
 * nothing; Run from here, offered when other nodes depend on it, says
 * how many come after it and asks first when it carries more than the
 * node. A refusal is said here, in the API's words, with Retry where a
 * retry can succeed. Inert while a run is in flight.
 */
export function RunSection({ member, graph }: { member: NodeMember; graph: CanvasGraph }) {
  // A Viewer runs nothing: the section is not drawn.
  return useViewOnly() ? null : <RunControls member={member} graph={graph} />;
}

function RunControls({ member, graph }: { member: NodeMember; graph: CanvasGraph }) {
  const runner = useRunner();
  const { runFrom, refusalFor, runNode, dismissRefusal } = useRunActions();
  const after = downstreamOf(graph, member.id);
  const inFlight = runner.state.active !== null && runner.state.active.outcome === null;
  const busy = runner.state.phase === "starting" || runner.state.phase === "cancelling" || runner.state.phase === "settling";
  const refusal = refusalFor(member.id);
  return (
    <section className={styles.sec} aria-label="Run" data-run-section>
      <h4 className={styles.secLabel}>Run</h4>
      <div className={styles.btnRow}>
        <Button variant="primary" size="compact" disabled={inFlight || busy} onClick={() => runNode(member)} data-run-node>
          <PlayIcon /> {member.step.output ? "Run again" : "Run this node"}
        </Button>
        {after.length > 0 ? (
          <Button variant="secondary" size="compact" disabled={inFlight || busy} onClick={() => runFrom(member)} data-run-from>
            <PlayIcon /> Run from here
          </Button>
        ) : null}
      </div>
      {after.length > 0 ? (
        <p className={styles.help}>
          Run from here also runs the {after.length} node{after.length === 1 ? "" : "s"} after it.
        </p>
      ) : null}
      {inFlight ? <p className={styles.help}>A run is in flight. Cancel it, or wait for it, to run again.</p> : null}
      {refusal ? (
        <p className={styles.problem} role="alert" data-run-refusal>
          {refusal.message}{" "}
          {refusal.retry ? (
            <Button variant="quiet" size="compact" onClick={refusal.retry}>
              Retry
            </Button>
          ) : null}
          <Button variant="quiet" size="compact" onClick={() => dismissRefusal(member.id)} aria-label="Dismiss">
            Dismiss
          </Button>
        </p>
      ) : null}
    </section>
  );
}
