"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import styles from "@/components/builder/MapBuilder.module.css";

const subscribeNever = () => () => {};

/**
 * The project page's header state (6): `Projects / <project name>`, the
 * name bold and renaming on click — the builder's own tail idiom,
 * reused. Delivered here at its component boundary; mounts it on the
 * real project route.
 */

/** The tail's presentation, exported for the boundary proof. */
export function ProjectCrumbTailView({
  name,
  editing,
  value,
  onValue,
  onStart,
  onCommit,
  onCancel,
}: {
  name: string;
  editing: boolean;
  value: string;
  onValue: (next: string) => void;
  onStart: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <span className={styles.crumbTail}>
      <span className={styles.crumbSep}>/</span>
      {editing ? (
        <input
          className={styles.nameInput}
          value={value}
          autoFocus
          aria-label="Project name"
          onChange={(e) => onValue(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onCancel();
          }}
        />
      ) : (
        <button
          className={styles.name}
          title={`Rename ${name}`}
          onClick={onStart}
        >
          {name}
        </button>
      )}
    </span>
  );
}

export function ProjectCrumbTail({
  projectId,
  name,
  onRename,
}: {
  projectId: string;
  name: string;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const cancelled = useRef(false);
  void projectId;
  // The project page's path, and so its title, is the home's own: it
  // names the project for every reader, not only the one who renames it.
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  if (!mounted) return null;
  const slot = document.getElementById("header-crumb-slot");
  if (!slot) return null;

  return createPortal(
    <ProjectCrumbTailView
      name={name}
      editing={editing}
      value={value}
      onValue={setValue}
      onStart={() => {
        setValue(name);
        cancelled.current = false;
        setEditing(true);
      }}
      onCommit={() => {
        setEditing(false);
        if (!cancelled.current && value.trim() && value.trim() !== name) {
          onRename(value.trim());
        }
        cancelled.current = false;
      }}
      onCancel={() => {
        cancelled.current = true;
        setEditing(false);
      }}
    />,
    slot,
  );
}
