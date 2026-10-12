"use client";

import { useEffect, useMemo, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { LayerRenderData } from "@/lib/layer-service";
import type { WidgetValues } from "@/lib/widget-service";
import {
  BASEMAPS,
  BASEMAP_FALLBACKS,
  type AttributionLine,
  type BasemapStyle,
} from "@/lib/basemap";
import { effectiveBasemap } from "@/lib/basemap-effective";
import { effectiveStyle } from "@/lib/viz";
import { liveFilters, liveDim } from "@/lib/live-filters";
import { featurePasses } from "@/lib/map-extent";
import {
  EXPORT_IMAGE_DEFINITION_SCHEMA,
  definitionRenderProblems,
  resolveMapScale,
  type ExportImageDefinition,
} from "@/lib/export/image-definition";
import { validateAgainstSchema } from "@/lib/export/schema-validate";
import type { RenderedLayer } from "@/components/map/MapCanvas";
import { ExportComposition } from "@/components/builder/export/ExportComposition";
import { buildCompositionMapInputs } from "@/components/builder/export/composition-map-inputs";
import { renderExportLegendLayers } from "@/components/builder/export/render-export-legend";
import type { AnswerState } from "@/components/widgets/dashboard-state";
import { boundToSnapshot } from "./state-binding";
import { documentFontsSettled, useLabelFont } from "@/components/map/label-font";

/**
 * The render route's view: assemble one map's stored state through the
 * documented API — the map record, each visible layer's render, the
 * widget values — and draw the shared export composition at the
 * definition's exact pixel size. Live selections and drafts are
 * builder-transient and deliberately absent: the server road renders
 * stored state. Failed renders and failed widget answers
 * surface as truthful prose in the composition, never silent absence.
 *
 * Readiness is declared on the root as data attributes the
 * driver waits for: every fetch final, the map idle with its committed
 * deck layers loaded, and the document's fonts ready, or given up on after
 * the label face's own bound when one never answers. The composition
 * mounts only once the label face has loaded, so the map's first build
 * draws its labels in it rather than readiness racing a rebuild. A missing or
 * invalid definition, or a map that does not exist, declares
 * data-export-failed with a worded reason instead of rendering nothing.
 */

declare global {
  interface Window {
    /** Injected by the renderer service before navigation — never URL. */
    __DEZFIL_EXPORT_DEFINITION__?: unknown;
  }
}

type Fetched<T> = { state: "loading" } | { state: "ok"; value: T } | {
  state: "failed";
  message: string;
};

export function RenderExportView({
  mapId,
  defaultBasemapUrl,
  basemapOverrideUrl,
  basemapOverrideAttribution = [],
  basemaps = BASEMAPS,
}: {
  mapId: string;
  defaultBasemapUrl: string;
  basemapOverrideUrl: string | null;
  /** The credit for that override, server-injected. */
  basemapOverrideAttribution?: AttributionLine[];
  /** The styles this instance offers, server-injected. */
  basemaps?: BasemapStyle[];
}) {
  // The definition, from the driver's request-scoped initialization.
  const [definition, setDefinition] = useState<
    ExportImageDefinition | { invalid: string } | null
  >(null);
  useEffect(() => {
    // Deferred a tick: the injected global is present before any script
    // runs, and the deferral keeps hydration's first pass clean.
    const timer = setTimeout(() => {
      const raw = window.__DEZFIL_EXPORT_DEFINITION__;
      if (raw === undefined) {
        setDefinition({
          invalid:
            "No export definition was provided. This page is driven by the " +
            "image export endpoint; open a map in the builder to export by hand.",
        });
        return;
      }
      const problems = validateAgainstSchema(
        raw,
        EXPORT_IMAGE_DEFINITION_SCHEMA,
      );
      const all =
        problems.length > 0
          ? problems
          : definitionRenderProblems(raw as ExportImageDefinition);
      setDefinition(
        all.length > 0
          ? { invalid: `The export definition is invalid: ${all[0]}` }
          : (raw as ExportImageDefinition),
      );
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const def =
    definition && !("invalid" in definition) ? definition : null;

  // The appearance is captured state: stamp the document root so every
  // token resolves exactly as the author's builder resolved it.
  useEffect(() => {
    if (!def) return;
    if (def.appearance === "dark") {
      document.documentElement.dataset.theme = "dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
  }, [def]);

  // ---- stored-state assembly, through the documented API ----
  const [map, setMap] = useState<Fetched<MapWithLayers>>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/maps/${encodeURIComponent(mapId)}`);
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(
            body?.error?.message ?? `The map could not be loaded (${r.status}).`,
          );
        }
        const value = (await r.json()) as MapWithLayers;
        if (!cancelled) setMap({ state: "ok", value });
      } catch (e) {
        if (!cancelled)
          setMap({
            state: "failed",
            message: e instanceof Error ? e.message : "The map could not be loaded.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapId]);

  const visibleLayers = useMemo(
    () => (map.state === "ok" ? map.value.layers.filter((l) => l.visible) : []),
    [map],
  );

  const [renders, setRenders] = useState<Record<string, Fetched<LayerRenderData>>>(
    {},
  );
  useEffect(() => {
    if (map.state !== "ok") return;
    let cancelled = false;
    for (const layer of visibleLayers) {
      void (async () => {
        // A tiled layer mid-build is NOT final: polling
        // continues until ready or failed, so readiness can never
        // declare over a blank archive — an unsettled build runs into
        // the driver's coded timeout instead of a blank PNG.
        for (;;) {
          try {
            const r = await fetch(
              `/api/layers/${encodeURIComponent(layer.id)}/render`,
            );
            const value = (await r.json()) as LayerRenderData;
            const building =
              value.ok &&
              value.mode === "tiled" &&
              value.tiles?.state === "building";
            if (!building) {
              if (!cancelled)
                setRenders((all) => ({
                  ...all,
                  [layer.id]: { state: "ok", value },
                }));
              return;
            }
          } catch {
            if (!cancelled)
              setRenders((all) => ({
                ...all,
                [layer.id]: {
                  state: "failed",
                  message: "The layer could not be fetched.",
                },
              }));
            return;
          }
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1000));
          if (cancelled) return;
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [map.state, visibleLayers]);

  // binding the declaration to one revision ---- The layer render
  // requests read each layer again on the server; a confirming read of
  // the map after they settle binds them to the snapshot declared below,
  // or restarts the assembly from the newer state. See state-binding.ts.
  const rendersSettled =
    map.state === "ok" &&
    visibleLayers.every((l) => {
      const fetched = renders[l.id];
      return fetched !== undefined && fetched.state !== "loading";
    });
  const [bound, setBound] = useState(false);
  useEffect(() => {
    if (!rendersSettled || map.state !== "ok" || bound) return;
    const snapshot = map.value;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/maps/${encodeURIComponent(mapId)}`);
        if (!r.ok) throw new Error(String(r.status));
        const fresh = (await r.json()) as MapWithLayers;
        if (cancelled) return;
        if (boundToSnapshot(snapshot, fresh)) {
          setBound(true);
        } else {
          setRenders({});
          setMap({ state: "ok", value: fresh });
        }
      } catch {
        if (!cancelled)
          setMap({
            state: "failed",
            message:
              "The map could not be read again, so the image cannot be bound to its state.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rendersSettled, map, bound, mapId]);

  const [values, setValues] = useState<
    Fetched<{ values: WidgetValues | null; state: AnswerState }>
  >({ state: "loading" });
  useEffect(() => {
    if (map.state !== "ok" || !def || def.widgets.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/maps/${encodeURIComponent(mapId)}/widget-values`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as WidgetValues;
        if (!cancelled)
          setValues({
            state: "ok",
            value: {
              values: body,
              state: { status: "current", error: null },
            },
          });
      } catch {
        // Truthful failure: the rail draws its documented failed state.
        if (!cancelled)
          setValues({
            state: "ok",
            value: {
              values: null,
              state: {
                status: "failed",
                error: { code: "internal", message: "Widget values failed." },
              },
            },
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [map.state, def, mapId]);

  // ---- derived composition inputs (stored state only) ----
  const stage = useMemo(() => {
    if (map.state !== "ok" || !def) return null;
    const m = map.value;
    const layers: RenderedLayer[] = [];
    const failures: string[] = [];
    for (const l of visibleLayers) {
      const fetched = renders[l.id];
      if (!fetched || fetched.state === "loading") return null;
      if (fetched.state === "failed") {
        failures.push(`${l.name}: ${fetched.message}`);
        continue;
      }
      const r = fetched.value;
      if (!r.ok) {
        failures.push(
          `${l.name}: ${r.error?.message ?? "could not render"}`,
        );
        continue;
      }
      // Stored live-filter dimensions apply CPU-SIDE on this route
      // rather than GPU-side: deck's GPU filter extension is
      // unreliable under the server's software-GL — observed drawing
      // unfiltered in the container and hanging elsewhere — so inline
      // features are filtered with the predicate that provably mirrors
      // the canvas, and the canvas gets no GPU dims at all. A tiled
      // layer whose stored filters are delegated cannot be filtered
      // here; drawing it unfiltered would silently lie, so it is
      // excluded with its truth stated.
      const docked = m.timeline?.layerId === l.id ? m.timeline.field : null;
      const dims =
        l.viz.type === "heatmap" && !r.liveFiltered
          ? []
          : liveFilters(l.viz, l.filters, docked).map(liveDim);
      const tiledUrl =
        r.mode === "tiled" && r.tiles?.state === "ready" && r.tiles.url
          ? { url: r.tiles.url, minZoom: r.tiles.minZoom, maxZoom: r.tiles.maxZoom }
          : null;
      if (tiledUrl && dims.length > 0) {
        failures.push(
          `${l.name}: live-filtered tiled layers cannot render in server exports yet`,
        );
        continue;
      }
      const gj = r.geojson as { features?: unknown[] } | null;
      const geojson =
        dims.length > 0 && gj?.features
          ? { ...gj, features: gj.features.filter((f) => featurePasses(f, dims)) }
          : r.geojson;
      layers.push({
        id: l.id,
        style: effectiveStyle(l.style, l.viz),
        visible: true,
        tooltip: [],
        popup: [],
        viz: l.viz,
        geojson,
        tiles: tiledUrl,
      });
    }

    // Order is the shared legend decision: the panel's way, or the
    // stored arrangement — the server road agrees with the rest.
    const legendLayers = renderExportLegendLayers(
      m.layers,
      m.legendOrder,
      renders,
    );

    // The shared derivation: a custom style wins in the exported image
    // exactly as it does everywhere else; otherwise the key, then Auto
    // following the definition's appearance.
    const eff = effectiveBasemap({
      key: m.basemap,
      custom: m.customBasemap,
      theme: def.appearance,
      overrideUrl: basemapOverrideUrl,
      basemaps,
      overrideAttribution: basemapOverrideAttribution,
      defaultUrl: defaultBasemapUrl,
    });

    const widgets = m.widgets.filter((w) => def.widgets.includes(w.id));
    return {
      layers,
      failures,
      legendLayers,
      basemap: {
        url: eff.url,
        kind: eff.kind,
        custom: eff.custom,
        attribution: eff.attribution,
        // Resolution happens at the shared composition-input boundary,
        // beside the card's identical decision.
        layers: m.basemapLayers,
      },
      widgets,
    };
  }, [
    map,
    def,
    renders,
    visibleLayers,
    basemapOverrideUrl,
    basemapOverrideAttribution,
    basemaps,
    defaultBasemapUrl,
  ]);

  // ---- readiness ----
  const [mapReady, setMapReady] = useState(false);
  const [initialWebGLFailure, setInitialWebGLFailure] = useState<string | null>(
    null,
  );
  const [fontsReady, setFontsReady] = useState(false);
  const labelFont = useLabelFont();
  const [legendPlacementReady, setLegendPlacementReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void documentFontsSettled().then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const valuesFinal =
    (def?.widgets.length ?? 0) === 0 || values.state !== "loading";
  // What is still unsettled, stated on the root: the driver's timeout
  // prose names it, and a stuck render is diagnosable from outside.
  const waiting = [
    !stage && "stage",
    !bound && "binding",
    !mapReady && "map",
    !fontsReady && "fonts",
    !valuesFinal && "values",
    !legendPlacementReady && "legend-placement",
  ]
    .filter(Boolean)
    .join(" ");
  const failed =
    (definition && "invalid" in definition && definition.invalid) ||
    (map.state === "failed" && map.message) ||
    initialWebGLFailure ||
    null;
  const ready =
    !failed &&
    !!stage &&
    !!def &&
    bound &&
    mapReady &&
    fontsReady &&
    valuesFinal &&
    legendPlacementReady;
  // What this page drew, declared beside its readiness: the map and layers
  // it fetched itself, the filters it applied, the legend order it laid
  // out, the widgets it placed, the attribution it credited, and every
  // truthful failure it composed in, from the one revision the confirming
  // read bound the layer reads to. The driver reads this from the settled
  // document, so the check attributes its image to the renderer's own
  // inputs and never to a later read of the map.
  const consumed =
    ready && stage && def && map.state === "ok"
      ? JSON.stringify({
          map: map.value.id,
          layers: visibleLayers.map((l) => ({ id: l.id, filters: l.filters })),
          legend: { visible: def.legend.visible, corner: def.legend.corner, order: stage.legendLayers.map((l) => l.id ?? l.name) },
          widgets: stage.widgets.map((w) => w.id),
          attribution: stage.basemap.attribution.map((a) => a.label).join(" "),
          failures: [
            ...stage.failures,
            ...(values.state === "ok" && values.value.state.status === "failed" ? ["Widget values failed."] : []),
          ],
        })
      : undefined;

  if (failed) {
    return (
      <div data-export-failed={failed} style={{ padding: 24 }}>
        <p>{failed}</p>
      </div>
    );
  }
  if (!def || !stage || !labelFont) {
    return <div data-export-loading="" />;
  }

  return (
    <div
      data-export-ready={ready || undefined}
      data-export-waiting={ready ? undefined : waiting}
      data-export-state={consumed}
      data-export-root=""
    >
      <ExportComposition
        width={def.size.width / resolveMapScale(def)}
        height={def.size.height / resolveMapScale(def)}
        outputWidth={def.size.width}
        widgetSize={def.widgetSize}
        credit={def.credit}
        map={buildCompositionMapInputs({
          definitionBasemapLayers: def.basemapLayers,
          storedBasemapLayers: stage.basemap.layers,
          basemapUrl: stage.basemap.url,
          basemapKind: stage.basemap.kind,
          customBasemap: stage.basemap.custom,
          fallbackColor: BASEMAP_FALLBACKS[def.appearance],
          layers: stage.layers,
          liveFilters: null,
          camera: def.viewport,
        })}
        onReadiness={setMapReady}
        onLegendPlacementReadiness={setLegendPlacementReady}
        onInitialWebGLFailure={setInitialWebGLFailure}
        legend={def.legend}
        legendLayers={stage.legendLayers}
        widgets={stage.widgets}
        values={values.state === "ok" ? values.value.values : null}
        valuesState={
          values.state === "ok"
            ? values.value.state
            : { status: "current", error: null }
        }
        selections={[]}
        title={def.title}
        attribution={stage.basemap.attribution}
        failures={stage.failures}
      />
    </div>
  );
}
