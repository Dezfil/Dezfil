"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { DataTable } from "./api";
import { readApiError } from "./api";
import { bboxAreaKm2 } from "@/lib/bbox";
import {
  OSM_PRESETS,
  parseSelector,
  buildOverpassQl,
  suggestStem,
  selectorLabel,
  type OsmArea,
} from "@/lib/osm/query";
import type { AreaSemantics } from "@/lib/overture/query";
import { TAG_SUGGESTIONS } from "@/lib/osm/tags";
import { AreaSemanticsToggle } from "./AreaSemanticsToggle";
import { QueryAreaPicker, type QueryAreaMode } from "./QueryAreaPicker";
import { QueryDrawer } from "./QueryDrawer";
import { Spinner } from "./Spinner";
import { ErrorNote } from "./ui/ErrorNote";
import type { DrawnShape, MiniViewport, AreaMode } from "./MiniMap";
import {
  FORM_DRIVEN,
  acceptDisclosure,
  actionsDisabled,
  cancelDisclosure,
  editDraft,
  formDisabled,
  openDisclosure,
  regenerateDisclosure,
} from "./osm-disclosure";
import { overpassLanguage } from "./overpass-language";
import drawerStyles from "./QueryDrawer.module.css";
import styles from "./OsmPane.module.css";
import { serverUnreachable } from "./failure-copy";

const MiniMap = dynamic(() => import("./MiniMap"), { ssr: false });
/* CodeMirror loads lazily — shared with the workspace and workbench. */
const SqlEditor = dynamic(() => import("./SqlEditor"), { ssr: false });

interface Props {
  initialViewport?: MiniViewport | null;
  onTableCreated: (table: DataTable) => void;
  /** The import's project context: a filed map's catalog
   * passes its project so the created table files in the same act. */
  projectId?: string | null;
}

/** Display-only envelope for the drawer; the server enforces its own. */
const PREVIEW_ENV = { timeoutS: 60, maxsizeBytes: 512 * 1024 * 1024 };

const PRESET_ICONS: Record<string, React.ReactNode> = {
  building: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 21V7l6-4v18M20 21V11l-6-3M4 21h16M8 9h.01M8 13h.01M8 17h.01" />
    </svg>
  ),
  highway: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 20 10 4M20 20 14 4M12 7v2M12 12v2M12 17v2" />
    </svg>
  ),
  amenity: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 3v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V3M8 3v18M17 3c-1.7 1.5-2.5 3.8-2.5 6.5 0 1.4.9 2.5 2.5 2.5V21" />
    </svg>
  ),
  landuse: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 21h18M5 21V9l5-5 4 4v13M14 21V12l5-3v12" />
    </svg>
  ),
};

function formatKm2(area: number): string {
  if (area >= 100) return `${Math.round(area).toLocaleString()} km²`;
  return `${area.toFixed(1)} km²`;
}

export function OsmPane({
  initialViewport,
  onTableCreated,
  projectId = null,
}: Props) {
  const [mode, setMode] = useState<QueryAreaMode>("rect");
  const [shape, setShape] = useState<DrawnShape | null>(null);
  const miniMode: AreaMode = mode === "layer" ? "pick" : (mode as AreaMode);
  // Overpass natively returns intersecting features — the OSM default.
  const [semantics, setSemantics] = useState<AreaSemantics>("intersect");
  const [entries, setEntries] = useState<string[]>(["amenity=restaurant"]);
  const [chipInput, setChipInput] = useState("");
  const [name, setName] = useState("osm_restaurant");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The query disclosure (identical in both hosts): closed and
  // form-driven by default; only acceptance arms a custom query. The
  // detach/regenerate semantics live underneath.
  const [disclosure, setDisclosure] = useState(FORM_DRIVEN);
  const customQl = disclosure.custom;

  const selectors = useMemo(
    () =>
      entries
        .map((e) => parseSelector(e))
        .filter((s): s is NonNullable<typeof s> => s !== null),
    [entries],
  );

  const area: OsmArea | null = useMemo(() => {
    if (!shape) return null;
    if (shape.kind === "polygon") return { ring: shape.ring };
    if (shape.kind === "feature") return { geometry: shape.geometry };
    return { bbox: shape.bbox };
  }, [shape]);

  const generatedQl = useMemo(() => {
    if (selectors.length === 0 || !area) return null;
    return buildOverpassQl(selectors, area, PREVIEW_ENV);
  }, [selectors, area]);

  const detached = customQl !== null;

  const syncName = useCallback(
    (nextEntries: string[]) => {
      if (nameEdited) return;
      const parsed = nextEntries
        .map((e) => parseSelector(e))
        .filter((s): s is NonNullable<typeof s> => s !== null);
      if (parsed.length > 0) setName(suggestStem(parsed));
    },
    [nameEdited],
  );

  const toggleEntry = useCallback(
    (entry: string) => {
      setEntries((current) => {
        const next = current.includes(entry)
          ? current.filter((e) => e !== entry)
          : [...current, entry];
        syncName(next);
        return next;
      });
    },
    [syncName],
  );

  const addChip = useCallback(() => {
    const parsed = parseSelector(chipInput);
    if (!parsed) {
      if (chipInput.trim()) setError(`"${chipInput}" is not a valid tag selector.`);
      return;
    }
    setError(null);
    const entry = selectorLabel(parsed);
    setEntries((current) => {
      if (current.includes(entry)) return current;
      const next = [...current, entry];
      syncName(next);
      return next;
    });
    setChipInput("");
  }, [chipInput, syncName]);

  // Run Query: the import's exact result on the dialog map. Keyed to
  // the full request — any change clears it.
  const [runBox, setRunBox] = useState<{
    key: string;
    data: {
      geojson: unknown;
      featureCount: number;
      truncated: boolean;
      cap: number;
    };
  } | null>(null);
  const [running, setRunning] = useState(false);
  const runKey = JSON.stringify({
    body: detached ? { ql: customQl } : { selectors: entries },
    shape,
    semantics,
  });
  const runResult = runBox?.key === runKey ? runBox.data : null;

  const runQuery = useCallback(async () => {
    if (running || !shape) return;
    if (!detached && selectors.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/imports/osm/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(detached ? { ql: customQl } : { selectors: entries }),
          ...(shape.kind === "polygon"
            ? { ring: shape.ring }
            : shape.kind === "feature"
              ? { geometry: shape.geometry }
              : { bbox: shape.bbox }),
          semantics,
        }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      setRunBox({
        key: runKey,
        data: (await response.json()) as {
          geojson: unknown;
          featureCount: number;
          truncated: boolean;
          cap: number;
        },
      });
    } catch {
      setError(serverUnreachable("run the query"));
    } finally {
      setRunning(false);
    }
  }, [
    running,
    shape,
    detached,
    customQl,
    selectors.length,
    entries,
    semantics,
    runKey,
  ]);

  const importNow = useCallback(async () => {
    if (busy || !shape) return;
    if (!detached && selectors.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/imports/osm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(detached ? { ql: customQl } : { selectors: entries }),
          ...(shape.kind === "polygon"
            ? { ring: shape.ring }
            : shape.kind === "feature"
              ? { geometry: shape.geometry }
              : { bbox: shape.bbox }),
          semantics,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(projectId !== null ? { projectId } : {}),
        }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as { tables: DataTable[] };
      // Every created class bubbles up — the map view adds a layer per
      // table, and the datasets list shows all of them.
      for (const table of body.tables) onTableCreated(table);
    } catch {
      setError(serverUnreachable("start the import"));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    shape,
    detached,
    customQl,
    selectors.length,
    entries,
    semantics,
    name,
    onTableCreated,
    projectId,
  ]);

  const areaKm2 = shape ? bboxAreaKm2(shape.bbox) : null;

  return (
    <div className={styles.split}>
      <div className={styles.mapside}>
        <MiniMap
          initialViewport={initialViewport}
          mode={miniMode}
          onShape={setShape}
          preview={runResult?.geojson ?? null}
        />

        <QueryDrawer
          open={disclosure.open}
          title="Overpass query"
          meta={
            <>
              endpoint &amp; limits enforced server-side · cached
              {semantics === "within"
                ? " · within-filter applied after fetch"
                : ""}
            </>
          }
          actions={
            <>
              <button
                onClick={() => setDisclosure((d) => cancelDisclosure(d))}
              >
                Cancel
              </button>
              <button
                data-primary
                disabled={disclosure.draft.trim() === ""}
                onClick={() => setDisclosure((d) => acceptDisclosure(d))}
              >
                Use query
              </button>
            </>
          }
        >
          <div className={drawerStyles.editorHost}>
            <SqlEditor
              value={disclosure.draft}
              editable
              hint="// Overpass QL. Pick tags and an area, or write your own"
              ariaLabel="Custom Overpass query"
              onChange={(text) => setDisclosure((d) => editDraft(d, text))}
              onRun={() => {}}
              language={overpassLanguage}
            />
          </div>
          <div className={drawerStyles.note}>
            {"{{bbox}}"} resolves to the selected area. Use query detaches
            the form; Regenerate from form returns to it and discards edits.
          </div>
        </QueryDrawer>
      </div>

      <div className={styles.ctrl}>
        <div className={styles.scroll}>
          <div
            className={styles.formPart}
            data-disabled={formDisabled(disclosure) || undefined}
            // Real disabled semantics, not just pointer styling: inert
            // removes the detached form from the tab order and from
            // assistive tech while the draft or a custom query owns
            // the request.
            inert={formDisabled(disclosure) || undefined}
          >
            <div className={styles.sectT}>Query Area</div>
            <QueryAreaPicker value={mode} onChange={setMode} />
            <div className={styles.areaChip}>
              <span>
                {mode === "layer" && shape?.kind === "feature"
                  ? `Feature from ${shape.source}`
                  : "Selected area"}
              </span>
              <b>{areaKm2 === null ? "—" : formatKm2(areaKm2)}</b>
            </div>
            <div className={styles.semantics}>
              <AreaSemanticsToggle
                value={semantics}
                onChange={setSemantics}
                edgeNoun="features"
              />
            </div>

            <div className={styles.sectT}>Quick queries</div>
            <div className={styles.presets}>
              {OSM_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={styles.preset}
                  data-on={entries.includes(p.key) || undefined}
                  onClick={() => toggleEntry(p.key)}
                >
                  {PRESET_ICONS[p.key]}
                  {p.label}
                </button>
              ))}
            </div>

            <div className={styles.sectT}>Tags</div>
            <div className={styles.chips}>
              {entries.map((entry) => (
                <span key={entry} className={styles.chip}>
                  {entry}
                  <button
                    title="Remove"
                    onClick={() => toggleEntry(entry)}
                    aria-label={`Remove ${entry}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                list="osm-tag-suggestions"
                placeholder="key=value ⏎"
                aria-label="Add a tag filter"
                value={chipInput}
                spellCheck={false}
                onChange={(e) => setChipInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addChip();
                  }
                }}
                onBlur={() => {
                  if (chipInput.trim()) addChip();
                }}
              />
              <datalist id="osm-tag-suggestions">
                {TAG_SUGGESTIONS.map((t) => (
                  <option key={t.entry} value={t.entry} />
                ))}
              </datalist>
            </div>

            <div className={styles.field}>
              <label htmlFor="osm-name">Table name</label>
              <input
                id="osm-name"
                className={styles.mono}
                value={name}
                spellCheck={false}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
              />
              <small>
                Lands split by geometry: {name || "stem"}_points / _lines /
                _polygons, non-empty classes only, refreshed together.
              </small>
            </div>
          </div>

          {error && (
            <ErrorNote message={error} onDismiss={() => setError(null)} />
          )}

          <p className={styles.hint}>
            Identical imports are served from cache. Un-promoted tags stay
            queryable in the <code>tags</code> column.
          </p>

          <div className={styles.queryRow}>
            {detached && (
              <span className={styles.customMark}>Custom query</span>
            )}
            {detached && (
              <button
                className={styles.queryBtn}
                disabled={disclosure.open}
                onClick={() => setDisclosure(regenerateDisclosure())}
              >
                ↺ Regenerate from form
              </button>
            )}
            <button
              className={styles.queryBtn}
              disabled={disclosure.open || (!detached && !generatedQl)}
              onClick={() =>
                setDisclosure((d) => openDisclosure(d, generatedQl))
              }
            >
              Edit query
            </button>
          </div>
        </div>
        <div className={styles.importBar}>
          {runResult && (
            <div className={styles.runStats} aria-live="polite">
              Showing {runResult.featureCount.toLocaleString()} features on
              the map
              {runResult.truncated
                ? `, first ${runResult.cap.toLocaleString()} of more`
                : ""}
            </div>
          )}
          <div className={styles.importActions}>
            <button
              className={styles.runBtn}
              onClick={() => void runQuery()}
              disabled={
                running ||
                busy ||
                actionsDisabled(disclosure) ||
                !shape ||
                (!detached && selectors.length === 0)
              }
            >
              {running ? "Running…" : "Run Query"}
            </button>
            <button
              className={styles.importBtn}
              onClick={() => void importNow()}
              disabled={
                busy ||
                running ||
                actionsDisabled(disclosure) ||
                !shape ||
                (!detached && selectors.length === 0)
              }
            >
              {busy ? "Querying OpenStreetMap…" : "Import as table"}
            </button>
            {(busy || running) && <Spinner size={16} />}
          </div>
        </div>
      </div>
    </div>
  );
}
