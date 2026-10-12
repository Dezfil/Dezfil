"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TemplateDetail } from "@/lib/templates/card";
import { formatBytes, readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { comesWith } from "./template-view-model";
import styles from "./TemplateCopyDialog.module.css";

/**
 * Make a copy: the version the dialog describes becomes the person's, in
 * a new project named as they type it (the title until they change it).
 * It says what comes, its size, whether it downloads first and that the
 * template stays as it is; confirming downloads that version when it is
 * not on this server yet, then copies it, both naming it, and lands in the
 * builder (a workflow example: on its canvas).
 *
 * The version is the one the dialog was shown with: the page's own from a
 * template's page, else the read of one answered once as the dialog
 * opened. Nothing reads the template again before confirming, so a newer
 * version listed meanwhile changes nothing here.
 */

const NAME_MAX = 120;

type Shown = { status: "reading" } | { status: "failed"; message: string } | { status: "shown"; template: TemplateDetail };

async function readOne(id: string): Promise<TemplateDetail> {
  let response: Response;
  try {
    response = await fetch(`/api/templates/${encodeURIComponent(id)}`);
  } catch {
    throw new Error(serverUnreachable("read the template"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TemplateDetail;
}

/** What the copy answers that the landing reads: the new project and
 * the map and workflow made in it. */
interface Landed {
  project: { id: string };
  members: { maps: { id: string }[]; recipes: { id: string }[] };
}

/** One POST naming the version: its answer, or why it was refused. */
async function post(path: string, body: unknown, action: string): Promise<{ refused: string } | { answer: Response }> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { refused: serverUnreachable(action) };
  }
  return response.ok ? { answer: response } : { refused: await readApiError(response) };
}

export function TemplateCopyDialog({
  id,
  template = null,
  onClose,
}: {
  id: string;
  /** The version as a template's page was served it; null to read it once now. */
  template?: TemplateDetail | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [shown, setShown] = useState<Shown>(template ? { status: "shown", template } : { status: "reading" });
  const [name, setName] = useState(template?.title ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const read = useRef(template !== null);

  // The read of one, once, as the dialog opens.
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    readOne(id).then(
      (detail) => {
        setShown({ status: "shown", template: detail });
        setName(detail.title);
      },
      (cause: unknown) => setShown({ status: "failed", message: cause instanceof Error ? cause.message : "The template could not be read." }),
    );
  }, [id]);

  const confirm = async () => {
    if (shown.status !== "shown" || copying) return;
    const described = shown.template;
    const typed = name.trim();
    if (!typed) {
      setProblem("Give it a name.");
      return;
    }
    if (typed.length > NAME_MAX) {
      setProblem(`At most ${NAME_MAX} characters.`);
      return;
    }
    setProblem(null);
    setCopying(true);
    const at = `/api/templates/${encodeURIComponent(described.id)}`;
    if (!described.present) {
      const fetched = await post(`${at}/fetch`, { version: described.version }, "download the template");
      if ("refused" in fetched) {
        setProblem(fetched.refused);
        setCopying(false);
        return;
      }
    }
    const copied = await post(`${at}/copy`, { name: typed, version: described.version }, "copy the template");
    if ("refused" in copied) {
      setProblem(copied.refused);
      setCopying(false);
      return;
    }
    const { project, members } = (await copied.answer.json()) as Landed;
    const recipe = members.recipes[0];
    const map = members.maps[0];
    router.push(
      described.kind === "workflow" && recipe ? `/workflows/${recipe.id}` : map ? `/maps/${map.id}` : `/projects/${project.id}`,
    );
  };

  const described = shown.status === "shown" ? shown.template : null;
  return (
    <Dialog
      label="Make a copy"
      onClose={() => {
        if (!copying) onClose();
      }}
      className={styles.dialog}
      data-template-copy-dialog
    >
      <div className={styles.head}>
        <strong>Make a copy</strong>
        {described ? (
          <small data-copy-sub>
            {described.title}, version {described.version}, becomes yours in a new project.
          </small>
        ) : null}
      </div>
      {shown.status === "reading" ? (
        <p className={styles.line} role="status">
          Reading the template…
        </p>
      ) : shown.status === "failed" ? (
        <p className={styles.problem} role="alert">
          {shown.message}
        </p>
      ) : (
        <>
          <label className={styles.nameField}>
            <span>Project name</span>
            <input
              autoFocus
              value={name}
              maxLength={NAME_MAX + 1}
              disabled={copying}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirm();
              }}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p className={styles.line} data-copy-comes>
            Comes with <b>{comesWith(shown.template)}</b>, {formatBytes(shown.template.size)}.
            {shown.template.present ? null : ` Downloads ${formatBytes(shown.template.size)} first.`} The template stays as it is.
          </p>
          {problem ? (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          ) : null}
        </>
      )}
      <div className={styles.foot}>
        <Button variant="quiet" onClick={onClose} disabled={copying}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void confirm()} busy={copying} disabled={!described} data-copy-confirm>
          Make a copy
        </Button>
      </div>
    </Dialog>
  );
}
