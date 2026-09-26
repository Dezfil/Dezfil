"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type {
  PlacesAnswer,
  SearchResponse,
} from "@/lib/search/contract";
import { matches } from "@/lib/search/match";
import { parseCoordinates } from "@/lib/search/coordinates";
import { buildRows, type SearchRows } from "./rows";

/**
 * The search field's state machine: layer names and coordinates answer
 * instantly from the shared browser-safe modules; attribute values
 * arrive through the endpoint behind the 300 ms debounce; places join
 * only a submitted search. One sequence number fences
 * everything — an older response, local or submitted, can never replace
 * newer query state.
 */

const DEBOUNCE_MS = 300;

/** The submitted places outcome, plus the transient in-flight state the
 * dropdown words (never a spinner left behind — every path resolves). */
export type PlacesState = PlacesAnswer | { state: "pending" } | null;

export interface SearchState {
  query: string;
  open: boolean;
  rows: SearchRows;
  /** The highlighted row's id; null = no highlight (Enter submits).
   * Identity, not a flat index — value rows arriving mid-navigation
   * must not re-point the highlight at a different row. */
  activeId: string | null;
  /** True while the debounced value search is in flight. */
  pending: boolean;
  /** Null until the current query is submitted. */
  places: PlacesState;
  submitted: boolean;
}

export function useSearch(mapId: string, map: MapWithLayers | null) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [server, setServer] = useState<SearchResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [places, setPlaces] = useState<PlacesState>(null);
  const [submitted, setSubmitted] = useState(false);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef("");

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const fetchSearch = useCallback(
    async (q: string, withPlaces: boolean, seq: number) => {
      // A superseded round is aborted, not merely ignored: the request
      // signal cancels the server's bounded scan, so stacked searches
      // cannot pile onto the hardened engine.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(
          `/api/maps/${mapId}/search?q=${encodeURIComponent(q)}${
            withPlaces ? "&places=1" : ""
          }`,
          { signal: controller.signal },
        );
        if (seqRef.current !== seq) return;
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as SearchResponse;
        if (seqRef.current !== seq) return;
        setServer(body);
        if (withPlaces) setPlaces(body.places ?? null);
      } catch {
        if (seqRef.current !== seq) return;
        // A failed local round leaves the instant groups standing; a
        // failed submitted round must still resolve the places group.
        if (withPlaces) {
          setPlaces({
            state: "failed",
            message: "Place search could not run.",
          });
        }
      } finally {
        if (seqRef.current === seq) setPending(false);
      }
    },
    [mapId],
  );

  /** A keystroke: new sequence, instant groups now, values debounced,
   * any submitted state dismissed — a new search moves on (S5). */
  const type = useCallback(
    (q: string) => {
      const seq = ++seqRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
      queryRef.current = q;
      setQuery(q);
      setActiveId(null);
      setPlaces(null);
      setSubmitted(false);
      setServer(null);
      const live = q.trim() !== "";
      setOpen(live);
      setPending(live);
      if (!live) return;
      timerRef.current = setTimeout(() => {
        void fetchSearch(q, false, seq);
      }, DEBOUNCE_MS);
    },
    [fetchSearch],
  );

  /** Reopening on focus re-runs the round: layer state may have changed
   * since the rows were fetched, and stale rows must not reopen. */
  const refresh = useCallback(() => {
    if (queryRef.current.trim() !== "") type(queryRef.current);
  }, [type]);

  /** Enter with no highlighted row: the places-inclusive search —
   * submission is the operational act of asking for places. */
  const submit = useCallback(() => {
    if (query.trim() === "") return;
    const seq = ++seqRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    setSubmitted(true);
    setPlaces({ state: "pending" });
    setPending(true);
    setOpen(true);
    void fetchSearch(query, true, seq);
  }, [fetchSearch, query]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveId(null);
  }, []);

  const rows = buildRows({
    layers:
      map && query.trim() !== ""
        ? map.layers
            .filter((l) => l.visible && matches(l.name, query))
            .map((l) => ({ layerId: l.id, name: l.name, viz: l.viz.type }))
        : [],
    values: server?.values ?? [],
    coordinates: parseCoordinates(query),
    places: places && places.state !== "pending" ? places : null,
  });

  const state: SearchState = {
    query,
    open,
    rows,
    // A highlight whose row left with a newer round clears rather than
    // pointing at whatever took its place.
    activeId: activeId !== null && rows.flat.some((r) => r.id === activeId)
      ? activeId
      : null,
    pending,
    places,
    submitted,
  };

  return { state, type, submit, close, refresh, setActiveId };
}
