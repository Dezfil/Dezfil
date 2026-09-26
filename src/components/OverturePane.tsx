"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { DataTable } from "./api";
import { readApiError } from "./api";
import { bboxAreaKm2, type Bbox } from "@/lib/bbox";
import {
  OVERTURE_THEMES,
  PLACE_CATEGORIES,
  type OvertureTheme,
} from "@/lib/overture/catalogue";
import {
  buildOvertureQuery,
  defaultSemantics,
  type AreaSemantics,
  type ResolvedScope,
} from "@/lib/overture/query";
import type { PolygonalGeometry } from "@/lib/geo-shape";
import { AreaSemanticsToggle } from "./AreaSemanticsToggle";
import { QueryAreaPicker, type QueryAreaMode } from "./QueryAreaPicker";
import { Spinner } from "./Spinner";
import { ErrorNote } from "./ui/ErrorNote";
import type { DrawnShape, MiniViewport, AreaMode } from "./MiniMap";
import { QueryDrawer } from "./QueryDrawer";
import drawerStyles from "./QueryDrawer.module.css";
import styles from "./OverturePane.module.css";
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

const THEME_ORDER: OvertureTheme[] = [
  "places",
  "buildings",
  "transportation",
  "divisions",
  "base",
  "addresses",
];

const THEME_ICONS: Record<OvertureTheme, React.ReactNode> = {
  places: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  buildings: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 21V7l6-4v18M20 21V11l-6-3M4 21h16" />
    </svg>
  ),
  transportation: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 20 10 4M20 20 14 4M12 7v2M12 12v2M12 17v2" />
    </svg>
  ),
  divisions: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M12 3v18" />
    </svg>
  ),
  base: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 7c3-2 6-2 9 0s6 2 9 0M3 12c3-2 6-2 9 0s6 2 9 0M3 17c3-2 6-2 9 0s6 2 9 0" />
    </svg>
  ),
  addresses: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9Z" />
      <path d="M9 21V12h6v9" />
    </svg>
  ),
};

const EDGE_NOUNS: Partial<Record<OvertureTheme, string>> = {
  transportation: "segments",
  base: "land and water shapes",
};

interface CountryEntry {
  code: string;
  name: string;
  bbox?: Bbox;
}

interface StateEntry {
  code: string;
  name: string;
  bbox?: Bbox;
}

interface LevelEntry {
  subtype: string;
  label: string;
  count: number;
  samples: string[];
}

interface CityMatch {
  id: string;
  name: string;
  kind: string;
  region: string | null;
  bbox?: Bbox;
}

/** The request-body scope for the current selection, or null while
 * incomplete. */
type ScopeParam =
  | { type: "country"; code: string; label?: string }
  | { type: "state"; code: string; label?: string }
  | { type: "division"; id: string; label?: string }
  | { type: "bbox"; bbox: [number, number, number, number] }
  | { type: "polygon"; ring: [number, number][] }
  | { type: "feature"; geometry: PolygonalGeometry; label?: string };

function formatKm2(area: number): string {
  if (area >= 100) return `${Math.round(area).toLocaleString()} km²`;
  return `${area.toFixed(1)} km²`;
}

function slug(s: string): string {
  const cleaned = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "area";
}

const BOUNDARY_MODES: QueryAreaMode[] = ["country", "state", "city"];

export function OverturePane({
  initialViewport,
  onTableCreated,
  projectId = null,
}: Props) {
  const [scopeMode, setScopeMode] = useState<QueryAreaMode>("rect");
  const [shape, setShape] = useState<DrawnShape | null>(null);

  const [countries, setCountries] = useState<CountryEntry[] | null>(null);
  const [countriesError, setCountriesError] = useState(false);
  const [countriesAttempt, setCountriesAttempt] = useState(1);
  const [country, setCountry] = useState("");
  // Fetched data is boxed with its request key and derived at render, so
  // stale entries read as "loading" without effect-time state resets.
  const [statesBox, setStatesBox] = useState<{
    key: string;
    data: StateEntry[];
  } | null>(null);
  const [stateCode, setStateCode] = useState("");
  const [cityQuery, setCityQuery] = useState("");
  const [cityBox, setCityBox] = useState<{
    key: string;
    data: CityMatch[];
  } | null>(null);
  const [city, setCity] = useState<{
    id: string;
    label: string;
    bbox?: Bbox;
  } | null>(null);

  const [theme, setTheme] = useState<OvertureTheme>("places");
  const [category, setCategory] = useState("");
  /** The chosen country's levels — the skeleton rows while scoped counts
   * load, and the source of the city-search example name. */
  const [countryLevelsBox, setCountryLevelsBox] = useState<{
    key: string;
    data: LevelEntry[];
  } | null>(null);
  /** Per-level counts under the active scope — the numbers the
   * level picker shows; zero levels are absent. */
  const [levelCountsBox, setLevelCountsBox] = useState<{
    key: string;
    data: { levels: LevelEntry[]; query?: string };
  } | null>(null);
  const [level, setLevel] = useState("region");
  /** Null = the theme's default; set = the user's explicit choice. */
  const [semanticsOverride, setSemanticsOverride] =
    useState<AreaSemantics | null>(null);

  const [releases, setReleases] = useState<string[]>([]);
  const [release, setRelease] = useState("");
  /** Null = follow the suggestion; a string = the user's own name. */
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewBox, setPreviewBox] = useState<{
    key: string;
    data: { count: number; query: string };
  } | null>(null);
  // The query disclosure (identical in both hosts): read-only — the
  // import is form-driven and there is no custom-SQL road, ruled at the
  // gate — closed by default, one click away.
  const [queryOpen, setQueryOpen] = useState(false);

  const geometricMode =
    scopeMode === "draw" ||
    scopeMode === "layer" ||
    scopeMode === "view" ||
    scopeMode === "rect";
  const miniMode: AreaMode =
    scopeMode === "layer" ? "pick" : geometricMode ? scopeMode : "idle";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/imports/overture/releases");
        if (!response.ok) return;
        const body = (await response.json()) as {
          releases: string[];
          latest: string;
        };
        if (!cancelled) {
          setReleases(body.releases);
          setRelease(body.latest);
        }
      } catch {
        /* The import itself will surface connectivity honestly */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Countries preload the moment the pane opens — no waiting for the
  // user to enter a boundaries mode.
  useEffect(() => {
    if (countries !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/imports/overture/divisions/countries?release=${release}`,
        );
        if (!response.ok) throw new Error();
        const body = (await response.json()) as { countries: CountryEntry[] };
        if (!cancelled) setCountries(body.countries);
      } catch {
        if (!cancelled) setCountriesError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [countries, release, countriesAttempt]);

  // States follow the chosen country.
  const statesKey = `${country}/${release}`;
  const states = statesBox?.key === statesKey ? statesBox.data : null;
  useEffect(() => {
    if (!country || scopeMode !== "state") return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/imports/overture/divisions/states?country=${country}&release=${release}`,
        );
        if (!response.ok) throw new Error();
        const body = (await response.json()) as { states: StateEntry[] };
        if (!cancelled) setStatesBox({ key: statesKey, data: body.states });
      } catch {
        if (!cancelled) setStatesBox({ key: statesKey, data: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [country, scopeMode, release, statesKey]);

  // The chosen country's level list — skeleton rows and example city name.
  const countryLevelsKey = `${country}/${release}`;
  const countryLevels =
    countryLevelsBox?.key === countryLevelsKey ? countryLevelsBox.data : null;
  useEffect(() => {
    if (!country || geometricMode) return;
    if (theme !== "divisions" && scopeMode !== "city") return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/imports/overture/divisions/levels?country=${country}&release=${release}`,
        );
        if (!response.ok) throw new Error();
        const body = (await response.json()) as { levels: LevelEntry[] };
        if (!cancelled)
          setCountryLevelsBox({ key: countryLevelsKey, data: body.levels });
      } catch {
        if (!cancelled)
          setCountryLevelsBox({ key: countryLevelsKey, data: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [country, theme, scopeMode, geometricMode, release, countryLevelsKey]);

  // City search: debounced against the division data.
  const cityKey = `${country}/${cityQuery.trim().toLowerCase()}/${release}`;
  const citySearching =
    scopeMode === "city" && !city && country !== "" &&
    cityQuery.trim().length >= 2;
  const cityMatches =
    cityBox?.key === cityKey && citySearching ? cityBox.data : null;
  useEffect(() => {
    if (!citySearching) return;
    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/imports/overture/divisions/search?country=${country}&q=${encodeURIComponent(cityQuery.trim())}&release=${release}`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as { matches: CityMatch[] };
        setCityBox({ key: cityKey, data: body.matches });
      } catch {
        /* Suggestions are best-effort */
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [cityQuery, country, citySearching, release, cityKey]);

  const scopeParam: ScopeParam | null = useMemo(() => {
    if (geometricMode) {
      if (!shape) return null;
      if (shape.kind === "bbox") return { type: "bbox", bbox: shape.bbox };
      if (shape.kind === "polygon")
        return { type: "polygon", ring: shape.ring };
      return {
        type: "feature",
        geometry: shape.geometry,
        label: shape.source,
      };
    }
    if (scopeMode === "country") {
      if (!country) return null;
      const label = countries?.find((c) => c.code === country)?.name;
      return { type: "country", code: country, ...(label ? { label } : {}) };
    }
    if (scopeMode === "state") {
      if (!stateCode) return null;
      const label = states?.find((s) => s.code === stateCode)?.name;
      return { type: "state", code: stateCode, ...(label ? { label } : {}) };
    }
    if (!city) return null;
    return { type: "division", id: city.id, label: city.label };
  }, [
    geometricMode,
    scopeMode,
    shape,
    country,
    countries,
    stateCode,
    states,
    city,
  ]);

  const scopeLabel =
    scopeParam && "label" in scopeParam ? scopeParam.label : undefined;
  const semantics = semanticsOverride ?? defaultSemantics(theme);
  // Semantics apply wherever geometry decides membership — every drawn or
  // picked shape, and named boundaries on data themes. Divisions inside a
  // named scope are attribute- or containment-scoped; no toggle there.
  const semanticsApply =
    geometricMode || (theme !== "divisions" && scopeParam !== null);

  // Per-level scoped counts: one debounced request fills every level row;
  // the level filter itself stays out of the key.
  const levelCountsKey = JSON.stringify({
    scopeParam,
    semantics,
    release,
  });
  const scopedLevels =
    theme === "divisions" && levelCountsBox?.key === levelCountsKey
      ? levelCountsBox.data
      : null;
  const levelCountsWanted =
    theme === "divisions" && scopeParam !== null && release !== "";
  useEffect(() => {
    if (!levelCountsWanted) return;
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/imports/overture/count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            theme: "divisions",
            scope: scopeParam,
            semantics,
            byLevel: true,
            ...(release ? { release } : {}),
          }),
        });
        if (!response.ok) {
          setError(await readApiError(response));
          return;
        }
        setError(null);
        setLevelCountsBox({
          key: levelCountsKey,
          data: (await response.json()) as {
            levels: LevelEntry[];
            query?: string;
          },
        });
      } catch {
        /* The rows keep their spinners; the import surfaces failures */
      }
    }, 600);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
    // levelCountsKey covers every input that changes the counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelCountsKey, levelCountsWanted]);

  // Keep the level choice among the levels that actually match the scope.
  const effectiveLevel =
    scopedLevels &&
    scopedLevels.levels.length > 0 &&
    !scopedLevels.levels.some((l) => l.subtype === level)
      ? scopedLevels.levels[0].subtype
      : level;

  const pickTheme = useCallback((t: OvertureTheme) => {
    setTheme(t);
    setSemanticsOverride(null);
    if (t !== "places") setCategory("");
  }, []);

  // Entering Boundaries preselects Divisions — the natural theme for
  // named areas; the user can still switch.
  const pickScopeMode = useCallback(
    (m: QueryAreaMode) => {
      if (
        BOUNDARY_MODES.includes(m) &&
        !BOUNDARY_MODES.includes(scopeMode)
      ) {
        pickTheme("divisions");
      }
      setScopeMode(m);
    },
    [scopeMode, pickTheme],
  );

  // The suggestion follows the selection until the user types a name.
  const name =
    nameOverride ??
    (theme === "divisions" && scopeLabel
      ? `${slug(scopeLabel)}_${effectiveLevel}`
      : scopeLabel
        ? `${slug(scopeLabel)}_${theme}`
        : `overture_${theme}`);

  // Count preview for themes without levels: named scopes only — drawn
  // areas already show their extent (divisions use per-level counts).
  const previewWanted =
    scopeParam !== null && theme !== "divisions" && !geometricMode;
  const previewKey = JSON.stringify({
    theme,
    scopeParam,
    category: category || undefined,
    semantics,
    release,
  });
  const preview = previewBox?.key === previewKey ? previewBox.data : null;
  useEffect(() => {
    if (!previewWanted) return;
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/imports/overture/count", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            theme,
            scope: scopeParam,
            semantics,
            ...(release ? { release } : {}),
            ...(category ? { category } : {}),
          }),
        });
        if (!response.ok) {
          setError(await readApiError(response));
          return;
        }
        setError(null);
        setPreviewBox({
          key: previewKey,
          data: (await response.json()) as { count: number; query: string },
        });
      } catch {
        /* The chip keeps counting…; the import surfaces failures */
      }
    }, 600);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
    // previewKey covers every input that changes the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewWanted]);

  // Run Query: the import's exact result, drawn on the dialog map.
  // Keyed to the full request — any input change clears it.
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
    theme,
    scopeParam,
    semantics,
    level: theme === "divisions" ? effectiveLevel : undefined,
    category: category || undefined,
    release,
  });
  const runResult = runBox?.key === runKey ? runBox.data : null;

  const runQuery = useCallback(async () => {
    if (!scopeParam || running) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/imports/overture/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          theme,
          scope: scopeParam,
          semantics,
          ...(theme === "divisions" && effectiveLevel
            ? { level: effectiveLevel }
            : {}),
          ...(release ? { release } : {}),
          ...(category ? { category } : {}),
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
    scopeParam,
    running,
    theme,
    semantics,
    effectiveLevel,
    release,
    category,
    runKey,
  ]);

  const importNow = useCallback(async () => {
    if (!scopeParam || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/imports/overture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          theme,
          scope: scopeParam,
          semantics,
          ...(theme === "divisions" && effectiveLevel
            ? { level: effectiveLevel }
            : {}),
          ...(release ? { release } : {}),
          ...(category ? { category } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(projectId !== null ? { projectId } : {}),
        }),
      });
      if (!response.ok) {
        setError(await readApiError(response));
        return;
      }
      onTableCreated((await response.json()) as DataTable);
    } catch {
      setError(serverUnreachable("start the import"));
    } finally {
      setBusy(false);
    }
  }, [
    scopeParam,
    busy,
    theme,
    semantics,
    effectiveLevel,
    release,
    category,
    name,
    onTableCreated,
    projectId,
  ]);

  const area = geometricMode && shape ? bboxAreaKm2(shape.bbox) : null;
  const spec = OVERTURE_THEMES[theme];

  // The disclosed query: exact client-side wherever the scope is
  // expressible here; otherwise the server's echoed query (scope
  // polygons resolve server-side). Computed only while disclosed.
  const sourceQuery = useMemo(() => {
    if (!queryOpen || !release) return null;
    const build = (resolved: ResolvedScope) => {
      try {
        return buildOvertureQuery(
          {
            theme,
            release,
            scope: resolved,
            semantics,
            ...(theme === "divisions" && effectiveLevel
              ? { level: effectiveLevel }
              : {}),
            ...(category ? { category } : {}),
          },
          theme === "addresses" ? [] : ["names", "categories"],
        );
      } catch {
        return null;
      }
    };
    if (geometricMode && shape) {
      return build(
        shape.kind === "bbox"
          ? { kind: "bbox", bbox: shape.bbox }
          : shape.kind === "polygon"
            ? { kind: "shape", wkt: "…drawn polygon…", bbox: shape.bbox }
            : {
                kind: "shape",
                wkt: `…${shape.source} feature…`,
                bbox: shape.bbox,
              },
      );
    }
    if (
      theme === "divisions" &&
      (scopeParam?.type === "country" || scopeParam?.type === "state")
    ) {
      return build(
        scopeParam.type === "country"
          ? { kind: "country", code: scopeParam.code.toUpperCase() }
          : { kind: "region", code: scopeParam.code.toUpperCase() },
      );
    }
    if (theme === "divisions") return scopedLevels?.query ?? null;
    return preview?.query ?? null;
  }, [
    queryOpen,
    release,
    geometricMode,
    shape,
    scopeParam,
    theme,
    semantics,
    effectiveLevel,
    category,
    scopedLevels,
    preview,
  ]);

  const sampleCity =
    countryLevels?.find((l) => l.subtype === "locality")?.samples[0] ??
    countryLevels?.find((l) => l.subtype === "county")?.samples[0] ??
    countryLevels?.find((l) => l.samples.length > 0)?.samples[0];

  // Fit-to-selection: the most specific chosen boundary's extent;
  // geometric modes leave the view alone.
  const focus = useMemo<Bbox | null>(() => {
    if (geometricMode) return null;
    if (scopeMode === "city" && city?.bbox) return city.bbox;
    if (scopeMode === "state" && stateCode) {
      const b = states?.find((s) => s.code === stateCode)?.bbox;
      if (b) return b;
    }
    if (country) return countries?.find((c) => c.code === country)?.bbox ?? null;
    return null;
  }, [geometricMode, scopeMode, city, stateCode, states, country, countries]);

  // The level rows: scoped counts once loaded; until then the country's
  // levels as a skeleton with spinners where the numbers will be.
  const levelRows: LevelEntry[] | null = scopedLevels
    ? scopedLevels.levels
    : !geometricMode && countryLevels
      ? countryLevels
      : null;
  const levelCountsLoading = scopedLevels === null;

  return (
    <div className={styles.split}>
      <div className={styles.mapside}>
        <MiniMap
          initialViewport={initialViewport}
          mode={miniMode}
          onShape={(s) => setShape(s)}
          preview={runResult?.geojson ?? null}
          focus={focus}
        />
        <QueryDrawer
          open={queryOpen}
          title="Source query"
          meta="read-only, driven by the settings"
          actions={
            <button onClick={() => setQueryOpen(false)}>Close</button>
          }
        >
          <div className={drawerStyles.editorHost}>
            <SqlEditor
              value={sourceQuery ?? "-- pick a release and a scope"}
              editable={false}
              hint=""
              ariaLabel="Overture source query"
              onChange={() => {}}
              onRun={() => {}}
            />
          </div>
        </QueryDrawer>
      </div>
      <div className={styles.ctrl}>
        <div className={styles.scroll}>
          <div className={styles.sectT}>Query Area</div>
          <QueryAreaPicker
            value={scopeMode}
            onChange={pickScopeMode}
            boundaries
          />

          {geometricMode ? (
            <div className={styles.areaChip}>
              <span>
                {scopeMode === "layer" && shape?.kind === "feature"
                  ? `Feature from ${shape.source}`
                  : "Selected area"}
              </span>
              <b>{area === null ? "—" : formatKm2(area)}</b>
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label htmlFor="ovt-country" className={styles.labelRow}>
                  Country
                  {countries === null && !countriesError && (
                    <Spinner size={11} />
                  )}
                </label>
                <select
                  id="ovt-country"
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    setStateCode("");
                    setCity(null);
                    setCityQuery("");
                  }}
                >
                  <option value="">
                    {countriesError
                      ? "No countries loaded"
                      : countries === null
                        ? "Loading countries…"
                        : "Pick a country"}
                  </option>
                  {(countries ?? []).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              {countriesError && (
                // The failure is a real note, not a placeholder option
                // pretending to be one.
                <ErrorNote
                  message="The country list couldn't be loaded."
                  onRetry={() => {
                    setCountriesError(false);
                    setCountriesAttempt((n) => n + 1);
                  }}
                />
              )}
              {scopeMode === "state" && country && (
                <div className={styles.field}>
                  <label htmlFor="ovt-state" className={styles.labelRow}>
                    State
                    {states === null && <Spinner size={11} />}
                  </label>
                  <select
                    id="ovt-state"
                    value={stateCode}
                    onChange={(e) => setStateCode(e.target.value)}
                  >
                    <option value="">
                      {states === null
                        ? "Loading states…"
                        : states.length === 0
                          ? "No states in this country"
                          : "Pick a state"}
                    </option>
                    {(states ?? []).map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {scopeMode === "city" && country && (
                <div className={styles.field}>
                  <label htmlFor="ovt-city" className={styles.labelRow}>
                    City or municipality
                    {citySearching && cityMatches === null && (
                      <Spinner size={11} />
                    )}
                  </label>
                  {city ? (
                    <div className={styles.cityPick}>
                      <span>{city.label}</span>
                      <button
                        type="button"
                        aria-label="Change city"
                        onClick={() => {
                          setCity(null);
                          setCityQuery("");
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        id="ovt-city"
                        placeholder={
                          sampleCity
                            ? `Type a name, e.g. ${sampleCity}`
                            : "Type a name"
                        }
                        value={cityQuery}
                        spellCheck={false}
                        onChange={(e) => setCityQuery(e.target.value)}
                      />
                      {cityMatches !== null && (
                        <div className={styles.cityList}>
                          {cityMatches.length === 0 && (
                            <span className={styles.cityEmpty}>
                              No matches in this country.
                            </span>
                          )}
                          {cityMatches.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() =>
                                setCity({
                                  id: m.id,
                                  label: m.name,
                                  ...(m.bbox ? { bbox: m.bbox } : {}),
                                })
                              }
                            >
                              <b>{m.name}</b>
                              <small>
                                {m.kind}
                                {m.region ? ` · ${m.region}` : ""}
                              </small>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className={styles.sectT}>Theme</div>
          <div className={styles.themes}>
            {THEME_ORDER.map((t) => (
              <button
                key={t}
                className={styles.theme}
                data-on={theme === t || undefined}
                onClick={() => pickTheme(t)}
              >
                {THEME_ICONS[t]}
                {OVERTURE_THEMES[t].label}
              </button>
            ))}
          </div>

          {theme === "divisions" && (
            <div className={styles.field}>
              <label>Level</label>
              {scopeParam === null ? (
                <select
                  value={level}
                  aria-label="Level"
                  onChange={(e) => setLevel(e.target.value)}
                >
                  {(
                    [
                      ["region", "States & regions"],
                      ["county", "Counties & districts"],
                      ["localadmin", "Municipalities"],
                      ["locality", "Cities & towns"],
                      ["macrohood", "City districts"],
                      ["neighborhood", "Neighborhoods"],
                    ] as [string, string][]
                  ).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : levelRows === null ? (
                <div className={styles.levelLoading}>
                  <Spinner size={12} /> Counting divisions in this selection…
                </div>
              ) : levelRows.length === 0 ? (
                <div className={styles.levelLoading}>
                  {levelCountsLoading ? (
                    <>
                      <Spinner size={12} /> Counting divisions in this
                      selection…
                    </>
                  ) : (
                    "No divisions inside this selection."
                  )}
                </div>
              ) : (
                <div className={styles.levels} aria-busy={levelCountsLoading}>
                  {levelRows.map((l) => (
                    <button
                      key={l.subtype}
                      type="button"
                      className={styles.level}
                      data-on={effectiveLevel === l.subtype || undefined}
                      onClick={() => setLevel(l.subtype)}
                    >
                      <span className={styles.levelHead}>
                        <b>{l.label}</b>
                        {levelCountsLoading ? (
                          <Spinner size={11} />
                        ) : (
                          <i>{l.count.toLocaleString()}</i>
                        )}
                      </span>
                      {l.samples.length > 0 && (
                        <small>{l.samples.join(" · ")}</small>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {spec.categoryFilter && (
            <div className={styles.field}>
              <label htmlFor="ovt-category">Category</label>
              <select
                id="ovt-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Any category</option>
                {PLACE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {semanticsApply && (
            <div className={styles.field}>
              <label>Area rule</label>
              <AreaSemanticsToggle
                value={semantics}
                onChange={setSemanticsOverride}
                edgeNoun={EDGE_NOUNS[theme] ?? "features"}
              />
            </div>
          )}

          {previewWanted && (
            <div className={styles.previewChip} aria-live="polite">
              <span>Matching features</span>
              <b>
                {preview === null ? (
                  <Spinner size={12} />
                ) : (
                  preview.count.toLocaleString()
                )}
              </b>
            </div>
          )}

          <div className={styles.field}>
            <label htmlFor="ovt-release">Release</label>
            <select
              id="ovt-release"
              value={release}
              onChange={(e) => setRelease(e.target.value)}
            >
              {releases.length === 0 && (
                <option value="">latest (resolving…)</option>
              )}
              {releases.map((r, i) => (
                <option key={r} value={r}>
                  {r}
                  {i === 0 ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="ovt-name">Table name</label>
            <input
              id="ovt-name"
              className={styles.mono}
              value={name}
              spellCheck={false}
              onChange={(e) => setNameOverride(e.target.value)}
            />
          </div>

          {error && (
            <ErrorNote message={error} onDismiss={() => setError(null)} />
          )}

          <p className={styles.hint}>
            Read straight from the public Overture S3 release. The result is
            a local GeoParquet snapshot.
          </p>

          <div className={styles.queryRow}>
            <button
              className={styles.queryBtn}
              disabled={queryOpen}
              onClick={() => setQueryOpen(true)}
            >
              View query
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
                !scopeParam ||
                (theme === "divisions" &&
                  scopedLevels !== null &&
                  scopedLevels.levels.length === 0)
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
                !scopeParam ||
                (theme === "divisions" &&
                  scopedLevels !== null &&
                  scopedLevels.levels.length === 0)
              }
            >
              {busy ? "Importing…" : "Import as table"}
            </button>
            {(busy || running) && <Spinner size={16} />}
          </div>
        </div>
      </div>
    </div>
  );
}
