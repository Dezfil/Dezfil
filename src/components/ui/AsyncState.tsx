"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Spinner } from "../Spinner";
import { ErrorNote } from "./ErrorNote";
import styles from "./AsyncState.module.css";

export type Async<T> =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "ready"; value: T };

/** Fetch-and-present as one contract.
 *
 * The rule the audits found broken: **empty is only ever shown after a
 * request has resolved successfully**. Screens that initialised their
 * collection to `[]` and rendered the empty branch immediately told the
 * user there was nothing there while the request was still in flight.
 * Pending, resolved-empty, failed and content are four states, and
 * they are mutually exclusive.
 *
 * Retry re-requests. The attempt counter is what makes that true: a late
 * answer from a superseded attempt can never overwrite a fresh one — the
 * pattern the widget rail already proved. */
export function useAsync<T>(
  load: () => Promise<T>,
  /** What the request depends on, as one string. A dependency *array*
   * would have to be spread into the effect's own deps, and a spread
   * element there is exactly the shape React's rules forbid — it silently
   * cost this hook its first request. */
  key: string,
): { state: Async<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(1);
  // An answer belongs to an attempt *and* a key: identifying it by attempt
  // alone let a key change keep showing the previous key's value until the
  // replacement landed — table detail would display the table you just
  // navigated away from instead of a pending state.
  const [answered, setAnswered] = useState<{
    attempt: number;
    key: string;
    state: Async<T>;
  }>({ attempt: 0, key: "", state: { status: "pending" } });

  // The loader is read through a ref so a caller can write it inline
  // without re-running the request on every render. Refreshed in an effect,
  // never during render.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    const mine = attempt;
    // No reset needed: an answer only counts when its attempt and its key
    // are the current ones, so a new request reads as pending until it
    // lands.
    void (async () => {
      try {
        const value = await loadRef.current();
        if (!cancelled)
          setAnswered({
            attempt: mine,
            key,
            state: { status: "ready", value },
          });
      } catch (cause) {
        if (cancelled) return;
        setAnswered({
          attempt: mine,
          key,
          state: {
            status: "failed",
            error:
              cause instanceof Error ? cause.message : "Something went wrong.",
          },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const state: Async<T> =
    answered.attempt === attempt && answered.key === key
      ? answered.state
      : { status: "pending" };
  return { state, retry };
}

/** Renders exactly one of the four states. `empty` is offered only when the
 * request resolved and the caller says the value is empty. */
export function AsyncState<T>({
  state,
  onRetry,
  pendingLabel = "Loading…",
  isEmpty,
  empty,
  children,
}: {
  state: Async<T>;
  onRetry?: () => void;
  pendingLabel?: string;
  isEmpty?: (value: T) => boolean;
  empty?: ReactNode;
  children: (value: T) => ReactNode;
}) {
  if (state.status === "pending")
    return (
      <p className={styles.pending} role="status">
        <Spinner size={12} />
        {pendingLabel}
      </p>
    );
  if (state.status === "failed")
    return <ErrorNote message={state.error} onRetry={onRetry} />;
  if (empty !== undefined && isEmpty?.(state.value))
    return <div className={styles.empty}>{empty}</div>;
  return <>{children(state.value)}</>;
}
