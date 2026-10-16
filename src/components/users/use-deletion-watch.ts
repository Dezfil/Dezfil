"use client";
import { useEffect, useRef } from "react";
import { readDeletionStatus, type DeletionStatus } from "./deletion-client";

/** How often a pending deletion's status is read. */
export const DELETION_WATCH_MS = 3000;

/**
 * While deletions are pending, their status is read every few seconds, so
 * the page tells working from finished without a reload. Each answer is
 * handed on: a status, or null for a deletion that has left the store. A
 * read that fails is tried again at the next turn. Reading stops when
 * nothing is pending and when the page goes away.
 */
export function useDeletionWatch(pending: readonly string[], onAnswer: (id: string, status: DeletionStatus | null) => void): void {
  const answer = useRef(onAnswer);
  useEffect(() => { answer.current = onAnswer; });
  const ids = pending.join("\0");
  useEffect(() => {
    if (ids === "") return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const turn = async () => {
      await Promise.all(ids.split("\0").map(async id => {
        let status: DeletionStatus | null;
        try { status = await readDeletionStatus(id); } catch { return; }
        if (!stopped) answer.current(id, status);
      }));
      if (!stopped) timer = setTimeout(() => void turn(), DELETION_WATCH_MS);
    };
    timer = setTimeout(() => void turn(), DELETION_WATCH_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [ids]);
}
