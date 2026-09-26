"use client";

import { useEffect, useRef, useState } from "react";
import { readApiError } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";
import type { PostgisRemoteRelation } from "./postgis-pane-types";

export interface PostgisPreviewColumn {
  name: string;
  type: string;
  spatialKind: "geometry" | "geography" | null;
}

export interface PostgisPreviewData {
  columns: PostgisPreviewColumn[];
  rows: Record<string, unknown>[];
}

export interface PostgisPreviewState {
  data: PostgisPreviewData | null;
  loading: boolean;
  error: string | null;
}

/** Debounced filtered preview. Cleanup and the monotonically increasing
 * request id make an older filter result unable to replace the current one.
 * The preview writes no connection health, so it reports no use: there is
 * nothing for the surface holding the badge to re-read. */
export function usePostgisPreview(
  connectionId: string,
  relation: PostgisRemoteRelation,
  filter: string,
): PostgisPreviewState {
  const [state, setState] = useState<PostgisPreviewState>({
    data: null,
    loading: true,
    error: null,
  });
  const sequence = useRef(0);

  useEffect(() => {
    const requestId = ++sequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState((current) => ({ ...current, loading: true, error: null }));
      let reachedApi = false;
      try {
        const response = await fetch(
          `/api/connections/postgis/${connectionId}/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              schema: relation.schema,
              table: relation.table,
              ...(filter.trim() ? { filter: filter.trim() } : {}),
            }),
            signal: controller.signal,
          },
        );
        reachedApi = true;
        if (!response.ok) throw new Error(await readApiError(response));
        const data = (await response.json()) as PostgisPreviewData;
        if (sequence.current === requestId) {
          setState({ data, loading: false, error: null });
        }
      } catch (cause) {
        if (controller.signal.aborted || sequence.current !== requestId) return;
        setState((current) => ({
          ...current,
          loading: false,
          error:
            reachedApi && cause instanceof Error
              ? cause.message
              : serverUnreachable("preview the relation"),
        }));
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [connectionId, filter, relation.schema, relation.table]);

  return state;
}
