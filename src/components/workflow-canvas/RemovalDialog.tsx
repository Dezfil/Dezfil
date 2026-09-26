"use client";

import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import type { NodeMember } from "./graph";
import type { RemovalPlan } from "./removal-model";
import styles from "./WorkflowCanvas.module.css";

/**
 * The one question before a node goes, asked in the words its state earns:
 * the dataset stays, the dataset is gone, or there never was one.
 * Confirming removes the node; Keep leaves everything.
 */
export function RemovalDialog({
  member,
  plan,
  busy,
  onConfirm,
  onClose,
}: {
  member: NodeMember;
  plan: RemovalPlan;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog label={`Remove ${member.label}`} onClose={onClose} className={styles.confirm} data-removal-dialog data-dataset-state={plan.state}>
      <div className={styles.confirmHead}>
        <strong>Remove {member.label}?</strong>
        <small>{plan.sentence}</small>
      </div>
      <div className={styles.confirmFoot}>
        <Button variant="quiet" onClick={onClose} disabled={busy} data-cancel-remove>
          Keep
        </Button>
        <Button variant="danger" onClick={onConfirm} busy={busy} data-confirm-remove>
          Remove
        </Button>
      </div>
    </Dialog>
  );
}
