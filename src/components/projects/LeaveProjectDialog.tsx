"use client";

import { useRef, useState } from "react";
import { readApiError } from "../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ErrorNote } from "../ui/ErrorNote";
import { invalidateProjects } from "../shell/use-project-name";
import styles from "./ProjectHome.module.css";

type FiledWorld = {
  maps: { projectId?: string | null; owner?: { sqlName: string } }[];
  workflows: { projectId?: string | null; owner?: { sqlName: string } }[];
  tables: { projectIds?: string[]; owner?: { sqlName: string } }[];
};
export function ownsFiledWork(world: FiledWorld, projectId: string, sqlName: string | null): boolean {
  return sqlName !== null && (
    [...world.maps, ...world.workflows].some(item => item.projectId === projectId && item.owner?.sqlName === sqlName) ||
    world.tables.some(item => item.projectIds?.includes(projectId) && item.owner?.sqlName === sqlName)
  );
}

/** The same menu-dialog contract as dissolution; success changes only the
 * caller's grant, so the host re-reads rather than unfiling local content. */
export function LeaveProjectDialog({ projectId, projectName, ownsWork, onClose, onDone }: {
  projectId: string; projectName: string; ownsWork: boolean;
  onClose: () => void; onDone: (notice: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const leave = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/leave`, { method: "POST" });
      if (!response.ok) throw new Error(await readApiError(response));
      invalidateProjects();
      onDone(`You left ${projectName}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project couldn't be left.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog label="Leave project" className={styles.dialog} onClose={() => { if (!inFlight.current) onClose(); }}>
      <div className={styles.dialogHead}>
        <strong>Leave {projectName}?</strong>
        <small>
          You will no longer see this project or work you could access only through it. Its owner can add you again.
          {ownsWork && " What you created here stays yours and stays in the project. You still find it in your own lists."}
        </small>
      </div>
      {error && <ErrorNote message={error} />}
      <div className={styles.dialogFoot}>
        <Button variant="quiet" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={() => void leave()} busy={busy}>Leave project</Button>
      </div>
    </Dialog>
  );
}
