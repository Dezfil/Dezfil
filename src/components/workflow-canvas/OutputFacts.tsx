"use client";

import { useState } from "react";
import type { TableListing } from "../api";
import { formatCount, formatRelativeTime } from "../api";
import { AddToMapDialog, tableSubject } from "../AddToMapDialog";
import { Button } from "../ui/Button";
import type { WorkflowStep } from "../workflow-model";
import { NO_GEOMETRY_LAYER } from "./band-selection";
import styles from "./WorkflowCanvas.module.css";

/**
 * The node panel's Output facts with *Add to a map* beside them: the
 * dataset, its rows, its last run, and the door to a map for a spatial
 * dataset, unavailable with the reason for a table, absent for an output
 * the listing no longer holds. Outside the panel's inert fieldsets: the
 * action changes a map, never the node, and stays usable while the node
 * waits in a run.
 */
export function OutputFacts({ step, outputName, table }: { step: WorkflowStep; outputName: string; table: TableListing | null }) {
  const [subject, setSubject] = useState<string | null>(null);
  return (
    <>
      <dl className={styles.kvs} data-output-facts>
        <div className={styles.kv}>
          <dt>Dataset</dt>
          <dd>{step.output?.name ?? outputName}</dd>
        </div>
        <div className={styles.kv}>
          <dt>Rows</dt>
          <dd>{table ? formatCount(table.rowCount) : "not listed"}</dd>
        </div>
        <div className={styles.kv}>
          <dt>Last run</dt>
          <dd data-plain>{step.lastSuccessAt ? formatRelativeTime(step.lastSuccessAt) : "no successful run"}</dd>
        </div>
      </dl>
      {table ? (
        <div data-output-actions>
          <div className={styles.btnRow}>
            <Button
              variant="secondary"
              size="compact"
              disabled={table.geometryColumn === null}
              title={table.geometryColumn === null ? NO_GEOMETRY_LAYER : undefined}
              onClick={() => setSubject(table.name)}
              data-add-to-map
            >
              Add to a map
            </Button>
          </div>
          {table.geometryColumn === null ? <p className={styles.help}>{NO_GEOMETRY_LAYER}</p> : null}
        </div>
      ) : null}
      <AddToMapDialog key={subject ?? "<closed>"} subject={tableSubject(subject)} onClose={() => setSubject(null)} />
    </>
  );
}
