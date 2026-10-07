"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Account } from "@/lib/metadata/accounts";
import type { LiveValues } from "./live-values";
import { settingsDeclarations, withLiveValues } from "./settings-index";
import { buildSearchIndex, searchSettings, type SearchHit } from "./settings-search";
import { useSearchSources } from "./use-search-sources";

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
const NONE: ReadonlyMap<string, string> = new Map();
const QUIET = () => () => {};

/**
 * The Settings search as the frame holds it: the query, the index over
 * what this person may see (read afresh each time a search starts, with
 * what the text fields on screen hold now over the served values), the
 * hits, and the keys: `/` focuses the field when no field has focus;
 * in the field, Escape clears it, the down arrow moves to the first hit
 * and Enter chooses it.
 */
export function useSettingsSearch(account: Account | null, live: LiveValues | null = null) {
  const admin = !!account?.isAdmin;
  const [query, setQuery] = useState(""), [session, setSession] = useState(0);
  const field = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const { sources, loading } = useSearchSources(session, admin);
  // Followed only while a search answers: typing in a card redraws nothing else.
  const subscribe = useCallback((listener: () => void) => searching && live ? live.subscribe(listener) : QUIET(), [live, searching]);
  const fields = useSyncExternalStore(subscribe, () => live?.snapshot() ?? NONE, () => NONE);
  const index = useMemo(() => account ? buildSearchIndex(withLiveValues(settingsDeclarations({
    account, tokens: sources.tokens ?? null, look: sources.look ?? null, instance: sources.instance ?? null, entry: sources.entry ?? null,
    health: sources.health ?? null, assistant: sources.assistant ?? null,
  }, admin), searching ? fields : NONE), admin) : [], [account, admin, sources, fields, searching]);
  const hits = useMemo(() => searching ? searchSettings(index, query) : [], [index, query, searching]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (TYPING.test(target.tagName ?? "") || target.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      field.current?.focus();
      field.current?.select?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /** A new search reads the tabs afresh; clearing the field returns to the tab. */
  const onQuery = (next: string) => {
    if (!query.trim() && next.trim()) setSession(value => value + 1);
    setQuery(next);
  };
  const fieldKeys = (event: KeyboardEvent<HTMLInputElement>, choose: (hit: SearchHit) => void) => {
    if (event.key === "Escape") { event.preventDefault(); onQuery(""); return; }
    if (event.key === "ArrowDown") {
      const first = list.current?.querySelector<HTMLElement>("button");
      if (first) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key === "Enter" && hits[0]) { event.preventDefault(); choose(hits[0]); }
  };
  return { query, onQuery, searching, hits, loading, field, list, fieldKeys, focusField: () => field.current?.focus() };
}
