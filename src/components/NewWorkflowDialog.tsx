"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "./api";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import styles from "./NewWorkflowDialog.module.css";

/**
 * The New-workflow name dialog (creation interaction, kept verbatim),
 * so the Workflows page and a project's home share one surface: a name
 * first (the canvas needs one), then the workflow is created — filed at
 * birth when a project is given (its provisional default) — and the
 * canvas opens on it.
 */

const NAME_MAX = 120;

export function NewWorkflowDialog({
  projectId,
  onClose,
}: {
  /** The project the workflow belongs to at birth; null for unfiled. */
  projectId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draftName, setDraftName] = useState("Untitled workflow");
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    const name = draftName.trim();
    if (!name) {
      setNameProblem("Give it a name.");
      return;
    }
    if (name.length > NAME_MAX) {
      setNameProblem(`At most ${NAME_MAX} characters.`);
      return;
    }
    setCreating(true);
    try {
      const response = await fetch("/api/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          origin: "workflow",
          ...(projectId !== null ? { projectId } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const { recipe } = (await response.json()) as { recipe: { id: string } };
      router.push(`/workflows/${recipe.id}`);
    } catch (e) {
      setNameProblem(
        e instanceof Error ? e.message : "The workflow couldn't be created.",
      );
      setCreating(false);
    }
  };

  return (
    <Dialog
      label="New workflow"
      onClose={() => {
        if (!creating) onClose();
      }}
      className={styles.dialog}
    >
      <div className={styles.head}>
        <strong>New workflow</strong>
        <small>Name it now; you can rename it on its page.</small>
      </div>
      <label className={styles.nameField}>
        <span>Name</span>
        <input
          autoFocus
          value={draftName}
          maxLength={NAME_MAX + 1}
          disabled={creating}
          onChange={(e) => {
            setDraftName(e.target.value);
            setNameProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      {nameProblem && (
        <p className={styles.problem} role="alert">
          {nameProblem}
        </p>
      )}
      <div className={styles.foot}>
        <Button variant="quiet" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void create()} busy={creating}>
          Create
        </Button>
      </div>
    </Dialog>
  );
}
