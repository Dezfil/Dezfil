"use client";

import { useCallback, useState } from "react";
import { useAsync, type Async } from "./ui/AsyncState";

/** The workspace screens' shared async scaffolding.
 *
 * A collection screen loads a list once and then edits it in place as the
 * user works — a delete removes a row, a publish flips one. The load runs
 * through the shared async contract, so pending, failed-with-retry and
 * resolved-empty keep their guarantees; the edits overlay the resolved
 * answer and are keyed to its identity, so a retry's fresh answer discards
 * them and server truth wins.
 *
 * `mutate` and `replace` are for event handlers, after the list has
 * resolved; before that they do nothing, because there is no list to edit.
 */
export function useAsyncCollection<T>(
  load: () => Promise<T[]>,
  key: string,
): {
  state: Async<T[]>;
  retry: () => void;
  mutate: (transform: (list: T[]) => T[]) => void;
  replace: (next: T[]) => void;
} {
  const { state: loadState, retry } = useAsync<T[]>(load, key);
  const [edits, setEdits] = useState<{ base: T[]; list: T[] } | null>(null);

  const base = loadState.status === "ready" ? loadState.value : null;
  const list = base ? (edits && edits.base === base ? edits.list : base) : null;

  // The transform reads the LATEST edit state inside the functional
  // updater, never a render-captured list: two overlapping mutations
  // (delete A, delete B in flight together) must both survive, whichever
  // settles last.
  const mutate = useCallback(
    (transform: (list: T[]) => T[]) => {
      if (!base) return;
      setEdits((cur) => {
        const current = cur && cur.base === base ? cur.list : base;
        return { base, list: transform(current) };
      });
    },
    [base],
  );

  const replace = useCallback(
    (next: T[]) => {
      if (!base) return;
      setEdits({ base, list: next });
    },
    [base],
  );

  const state: Async<T[]> =
    base && list ? { status: "ready", value: list } : loadState;

  return { state, retry, mutate, replace };
}
