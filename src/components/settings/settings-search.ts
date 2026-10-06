import { canOpenTab, SETTINGS_GROUPS, SETTINGS_TABS, type SettingsTabId } from "./settings-tabs";

/**
 * The Settings search: an index over every tab, card and row the person
 * may see, matched by the label they see, keywords and the words of the
 * current value, and two pointers to controls outside the page (the
 * header's light or dark button; Users, for an admin). A row a tab marks
 * secret (a password field, a new token's secret) is never read into the
 * index, neither its value nor its name. A browser convenience over the
 * tabs' served data: nothing here is kept.
 */

export interface IndexRow {
  /** The element a hit lands on. */
  readonly id: string;
  /** The label as the row shows it. */
  readonly label: string;
  /** Words the row is also found by. */
  readonly keys?: string;
  /** The words of its current value: a chosen option, a field's text, a read-only value. */
  readonly value?: string;
  /** A password or a secret: never indexed. */
  readonly secret?: boolean;
}

export interface IndexCard {
  readonly id: string;
  readonly title: string;
  readonly keys?: string;
  readonly rows: readonly IndexRow[];
}

/** What each tab declares: its cards, top to bottom. */
export type TabDeclarations = Partial<Record<SettingsTabId, readonly IndexCard[]>>;

export type Pointer = "theme" | "users";

export interface SearchEntry {
  readonly kind: "tab" | "card" | "row" | "pointer";
  readonly tab?: SettingsTabId;
  readonly pointer?: Pointer;
  /** The element a hit lands on: a card or a row. */
  readonly id?: string;
  readonly label: string;
  readonly keys: string;
  /** A row's card. */
  readonly card?: string;
  readonly value?: string;
  /** What a tab, card or pointer hit says under its path. */
  readonly meta?: string;
  /** Where a pointer is. */
  readonly where?: string;
}

export type SearchTarget = { readonly tab: SettingsTabId; readonly anchor: string | null } | { readonly pointer: Pointer };

export interface SearchHit {
  readonly entry: SearchEntry;
  /** "Group / Tab · " before the name, or "Where / " for a pointer. */
  readonly prefix: string;
  readonly name: string;
  /** The card and a value excerpt, or the entry's own line. */
  readonly meta: string;
  readonly target: SearchTarget;
}

const POINTERS: readonly (SearchEntry & { pointer: Pointer })[] = [
  { kind: "pointer", pointer: "theme", where: "Header", label: "Light or dark", meta: "The button at the top right of every page",
    keys: "theme dark light night day mode colour color scheme" },
  { kind: "pointer", pointer: "users", where: "Side menu", label: "Users", meta: "Invite people and manage their roles",
    keys: "users people person invite invitation member members admin admins role roles deactivate" },
];

/** The index for this person: only the tabs they may open, and Users only for an admin. */
export function buildSearchIndex(tabs: TabDeclarations, admin: boolean): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const tab of SETTINGS_TABS) {
    if (!canOpenTab(tab.id, admin)) continue;
    const cards = tabs[tab.id] ?? [];
    out.push({ kind: "tab", tab: tab.id, label: tab.label, keys: "", meta: cards.map(card => card.title).join(", ") });
    for (const card of cards) {
      const rows = card.rows.filter(row => !row.secret);
      const names = rows.map(row => row.label);
      out.push({ kind: "card", tab: tab.id, id: card.id, label: card.title, keys: card.keys ?? "",
        meta: names.slice(0, 6).join(", ") + (names.length > 6 ? ", …" : "") });
      for (const row of rows) {
        out.push({ kind: "row", tab: tab.id, id: row.id, label: row.label, keys: row.keys ?? "", card: card.title, value: row.value ?? "" });
      }
    }
  }
  return [...out, ...POINTERS.filter(pointer => admin || pointer.pointer !== "users")];
}

const TAB_ORDER = new Map(SETTINGS_TABS.map((tab, index) => [tab.id, index]));
const tabOf = (id: SettingsTabId) => SETTINGS_TABS.find(tab => tab.id === id)!;
const groupOf = (id: SettingsTabId) => SETTINGS_GROUPS.find(group => group.id === tabOf(id).group)!.label;

/** A long value around the words it was found by. */
export function excerpt(text: string, word: string, width = 72): string {
  if (text.length <= width) return text;
  const at = Math.max(0, text.toLowerCase().indexOf(word));
  const from = Math.max(0, at - 24);
  return (from > 0 ? "…" : "") + text.slice(from, from + width) + (from + width < text.length ? "…" : "");
}

/** How well an entry answers the query: lower is better, null is no match. */
function rank(entry: SearchEntry, query: string, words: readonly string[]): number | null {
  const label = entry.label.toLowerCase(), keys = entry.keys.toLowerCase(), value = (entry.value ?? "").toLowerCase();
  if (entry.kind === "tab" || entry.kind === "card") {
    if (label.startsWith(query)) return entry.kind === "tab" ? 0 : 1;
    if (label.includes(query)) return entry.kind === "tab" ? 2 : 3;
    if (entry.kind === "card" && keys && words.every(word => keys.includes(word) || label.includes(word))) return 5;
    return null;
  }
  const place = entry.tab ? tabOf(entry.tab).label : entry.where ?? "";
  const hay = [label, keys, value, (entry.card ?? "").toLowerCase(), place.toLowerCase()].join(" ");
  if (!words.every(word => hay.includes(word))) return null;
  if (!words.some(word => label.includes(word) || keys.includes(word) || value.includes(word))) return null;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (words.some(word => label.includes(word))) return 3;
  if (words.some(word => keys.includes(word))) return 4;
  return 6;
}

function hit(entry: SearchEntry, firstWord: string): SearchHit {
  if (entry.kind === "pointer") {
    return { entry, prefix: `${entry.where} / `, name: entry.label, meta: entry.meta ?? "", target: { pointer: entry.pointer! } };
  }
  const tab = entry.tab!, group = groupOf(tab), tabLabel = tabOf(tab).label;
  if (entry.kind === "tab") return { entry, prefix: `${group} / `, name: tabLabel, meta: entry.meta ?? "", target: { tab, anchor: null } };
  const prefix = `${group} / ${tabLabel} · `;
  if (entry.kind === "card") return { entry, prefix, name: entry.label, meta: entry.meta ?? "", target: { tab, anchor: entry.id ?? null } };
  const bits: string[] = [];
  if (entry.card && entry.card !== entry.label) bits.push(entry.card);
  if (entry.value) bits.push(excerpt(entry.value, firstWord));
  return { entry, prefix, name: entry.label, meta: bits.join(" · "), target: { tab, anchor: entry.id ?? null } };
}

/** The hits for a query, best first: by rank, then the tabs' order, then the order drawn. */
export function searchSettings(index: readonly SearchEntry[], raw: string): SearchHit[] {
  const query = raw.toLowerCase().trim();
  if (!query) return [];
  const words = query.split(/\s+/).filter(Boolean);
  const order = (entry: SearchEntry) => entry.tab ? TAB_ORDER.get(entry.tab)! : 99;
  const scored = index.flatMap((entry, position) => {
    const score = rank(entry, query, words);
    return score === null ? [] : [{ entry, score, position }];
  }).sort((a, b) => a.score - b.score || order(a.entry) - order(b.entry) || a.position - b.position);
  const seen = new Set<string>();
  return scored.filter(({ entry }) => {
    const key = `${entry.kind}:${entry.tab ?? entry.pointer}:${entry.id ?? ""}:${entry.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ entry }) => hit(entry, words[0]));
}

/** A hit as one line: `Group / Tab · Row`. */
export function hitPath(hit: SearchHit): string {
  return hit.prefix + hit.name;
}

/** The first place `query` (or else its first word) occurs in `text`, to mark it. */
export function markRange(text: string, raw: string): [number, number] | null {
  const query = raw.toLowerCase().trim();
  if (!query) return null;
  const lower = text.toLowerCase();
  for (const needle of [query, query.split(/\s+/)[0]]) {
    const at = lower.indexOf(needle);
    if (at >= 0) return [at, at + needle.length];
  }
  return null;
}
