"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BUILT_IN_ATTRIBUTION } from "@/lib/basemap";
import type { TemplateList } from "@/lib/templates/card";
import { readApiError } from "../api";
import { useOperations } from "../builder/drawer/use-operations";
import { serverUnreachable } from "../failure-copy";
import { IconSearch } from "../gallery-icons";
import gallery from "../gallery.module.css";
import { ListHeading } from "../ListHeading";
import { PicturesCreditLine } from "../PictureCredit";
import { useTheme } from "../theme";
import { AsyncState, useAsync } from "../ui/AsyncState";
import { InfoIcon } from "../ui/icons";
import { TemplateCard } from "./TemplateCard";
import { TemplateCopyDialog } from "./TemplateCopyDialog";
import styles from "./Templates.module.css";
import {
  carriesTag,
  matchesSearch,
  NO_MATCH_LINE,
  refreshes,
  screenLine,
  tagChips,
  templateAddress,
  type TagPick,
} from "./template-model";

/**
 * The Templates page: one card per template, in the list's order (the
 * shipped ones first, then the catalogue's), maps and workflow examples
 * in one grid. The page draws from what the server holds at once and asks
 * it to read the catalogue after, so it never waits on the catalogue;
 * while the catalogue lists nothing here, one line says why. A search box
 * narrows by title, question, place and credit, the tag chips by tag, with
 * counts that follow the search; there is no sort, since the list's order
 * is the curated one. With no card at all there is nothing to narrow: the
 * page shows its line alone, with neither the search box nor a chip.
 */

async function readTemplates(): Promise<TemplateList> {
  let response: Response;
  try {
    response = await fetch("/api/templates", { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the templates"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TemplateList;
}

async function refreshTemplates(): Promise<TemplateList> {
  let response: Response;
  try {
    response = await fetch("/api/templates/refresh", { method: "POST", cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("read the template catalogue"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TemplateList;
}

/** The refresh's answer, with the list it refreshed: a retried list asks
 * again, and an answer never lands on a list it was not asked for. */
interface Refreshed {
  of: TemplateList;
  list: TemplateList | null;
  error: string | null;
}

export function TemplatesScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { operations } = useOperations();
  const { state, retry } = useAsync(readTemplates, "templates");
  const first = state.status === "ready" ? state.value : null;
  const [refreshed, setRefreshed] = useState<Refreshed | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<TagPick>("all");
  const [copying, setCopying] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, unless the person is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!first || !refreshes(first.catalogue)) return;
    let cancelled = false;
    refreshTemplates().then(
      (list) => {
        if (!cancelled) setRefreshed({ of: first, list, error: null });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setRefreshed({
            of: first,
            list: null,
            error: cause instanceof Error ? cause.message : "The template catalogue could not be read.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [first]);

  const answer = refreshed && refreshed.of === first ? refreshed : null;
  const list = answer?.list ?? first;
  const reading = first !== null && refreshes(first.catalogue) && answer === null;
  const line = screenLine(list, answer?.error ?? null, reading);

  // A chip only for a tag some template carries; a pick whose tag left the
  // list (a refresh replaced it) reads as All.
  const chips = useMemo(() => (list ? tagChips(list.templates, query) : null), [list, query]);
  const pick: TagPick = chips?.some((chip) => chip.pick === picked) ? picked : "all";
  // Shown until a list has answered with no card at all.
  const narrowing = !list || list.templates.length > 0;
  const shown = useMemo(
    () => list?.templates.filter((card) => carriesTag(card, pick) && matchesSearch(card, query)) ?? null,
    [list, pick, query],
  );
  // A map template's picture is drawn on the built-in style for its theme,
  // as the copy records it, so a page showing one credits that style.
  const pictured = shown?.some((card) => !card.steps && card.picture === "kept") ?? false;

  const groupOf = useCallback(
    (operation: string) => operations?.find((o) => o.id === operation)?.group ?? null,
    [operations],
  );
  const labelOf = useMemo(
    () =>
      operations
        ? (operation: string) => operations.find((o) => o.id === operation)?.label ?? operation
        : null,
    [operations],
  );

  return (
    <div className={styles.screen}>
      <ListHeading
        title="Templates"
        line="Finished maps and workflows on open data. Open one to see how it is made, or make a copy to work on."
      />
      {narrowing && (
        <div className={gallery.toolbar}>
          <label className={gallery.search}>
            <IconSearch />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates…"
              aria-label="Search templates"
            />
            <kbd>/</kbd>
          </label>
          <div className={gallery.chips} role="group" aria-label="Filter templates">
            {/* Counts appear once the list has answered: a chip saying 0
                while it is read would be wrong. */}
            {chips === null ? (
              <button type="button" className={gallery.filterChip} data-on>
                All
              </button>
            ) : (
              chips.map((chip) => (
                <button
                  type="button"
                  key={chip.pick}
                  className={gallery.filterChip}
                  data-on={chip.pick === pick || undefined}
                  onClick={() => setPicked(chip.pick)}
                >
                  {chip.label}
                  <span className={gallery.chipCount}> · {chip.count}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      {line && (
        <p className={styles.catalogueLine} role="status" data-catalogue-line>
          <InfoIcon />
          <span>{line}</span>
        </p>
      )}
      <div className={gallery.scroller}>
        <AsyncState state={state} onRetry={retry} pendingLabel="Reading the templates…">
          {() =>
            shown && shown.length > 0 ? (
              <div className={gallery.grid}>
                {shown.map((card, i) => (
                  <TemplateCard
                    key={card.id}
                    card={card}
                    index={i}
                    theme={theme}
                    groupOf={groupOf}
                    labelOf={labelOf}
                    onOpen={() => router.push(templateAddress(card.id))}
                    onCopy={() => setCopying(card.id)}
                  />
                ))}
              </div>
            ) : list && list.templates.length > 0 ? (
              <p className={gallery.empty} data-empty-line>
                {NO_MATCH_LINE}
              </p>
            ) : line ? null : (
              <p className={gallery.empty}>No templates on this server yet.</p>
            )
          }
        </AsyncState>
      </div>
      {/* Under the scroller, as on Maps: the cards crop the credit the
          pictures carry in their corner. */}
      <PicturesCreditLine lines={pictured ? BUILT_IN_ATTRIBUTION : []} placement="page" />
      {copying ? <TemplateCopyDialog key={copying} id={copying} onClose={() => setCopying(null)} /> : null}
    </div>
  );
}
