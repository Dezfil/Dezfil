"use client";
import type { KeyboardEvent, ReactNode, Ref, RefObject } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { ArrowRightIcon, SearchIcon, XIcon } from "@/components/ui/icons";
import { markRange, type SearchHit } from "./settings-search";
import cardStyles from "./SettingsCard.module.css";
import styles from "./SettingsSearch.module.css";

/** "Search settings", at the head of the tab column. */
export function SearchField({ value, inputRef, onQuery, onKeyDown }: {
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return <label className={styles.search}>
    <SearchIcon />
    <input ref={inputRef} type="search" value={value} placeholder="Search settings" aria-label="Search settings"
      autoComplete="off" spellCheck={false} onChange={event => onQuery(event.target.value)} onKeyDown={onKeyDown} />
    {value && <IconButton action="Clear the search" icon={<XIcon />} className={styles.clear}
      onClick={() => { onQuery(""); inputRef.current?.focus(); }} />}
  </label>;
}

/** `text` with the place the query was found marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const range = markRange(text, query);
  if (!range) return <>{text}</>;
  return <>{text.slice(0, range[0])}<mark>{text.slice(range[0], range[1])}</mark>{text.slice(range[1])}</>;
}

function heading(query: string, count: number, loading: boolean): ReactNode {
  const asked = `“${query.trim()}”`;
  if (count) return `${count} ${count === 1 ? "result" : "results"} for ${asked}`;
  return loading ? "Searching…" : `No settings match ${asked}`;
}

/**
 * The search's answer, in the content's place: a line per hit,
 * `Group / Tab · Row` with its card and a value excerpt under it. The
 * arrows walk the hits, the up arrow from the first and Escape go back
 * to the field, and choosing a hit opens it.
 */
export function SearchResults({ query, hits, loading, listRef, onChoose, onField }: {
  query: string;
  hits: readonly SearchHit[];
  loading: boolean;
  listRef: Ref<HTMLDivElement>;
  onChoose: (hit: SearchHit) => void;
  onField: () => void;
}) {
  const walk = (event: KeyboardEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const all = Array.from(button.parentElement?.children ?? []) as HTMLElement[], at = all.indexOf(button);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      all[at + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (at > 0) all[at - 1].focus(); else onField();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onField();
    }
  };
  return <section className={`${cardStyles.card} ${styles.found}`} aria-labelledby="settings-search-heading">
    <h2 id="settings-search-heading" role="status">{heading(query, hits.length, loading)}</h2>
    {hits.length > 0 && <div ref={listRef} className={styles.results}>
      {hits.map(hit => <button key={`${hit.entry.kind}:${hit.entry.tab ?? hit.entry.pointer}:${hit.entry.id ?? ""}:${hit.name}`} type="button"
        className={styles.result} onClick={() => onChoose(hit)} onKeyDown={walk}>
        <span className={styles.resultText}>
          <span className={styles.resultPath}>{hit.prefix}<b><Marked text={hit.name} query={query} /></b></span>
          {hit.meta && <span className={styles.resultMeta}><Marked text={hit.meta} query={query} /></span>}
        </span>
        <ArrowRightIcon />
      </button>)}
    </div>}
  </section>;
}
