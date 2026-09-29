import type { AccountScope } from "@/lib/auth/scope";
import { requireMap } from "@/lib/map-access";
import { ApiError } from "@/lib/api/errors";
import { publishedMessage } from "@/lib/api/error-catalogue";
import {
  getMap,
  getMapByToken,
  getPublishedSnapshot,
  getPublishedTheme,
  getViewerControls,
  normalizeViewerControls,
  setPublishedTheme,
  setViewerControls,
  updateMapFields,
  type CustomBasemap,
  type Layer,
  type MapNote,
  type PublishedTheme,
  type ViewerControls,
  type Viewport,
} from "@/lib/metadata/maps";
import { metadataDb } from "@/lib/metadata/db";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { Corner } from "@/lib/corners";
import type { MapTimeline } from "@/lib/timeline";
import {
  renderLayer,
  layerFieldStats,
  type LayerRenderData,
} from "@/lib/layer-service";
import {
  autoBasemapUrlForTheme,
  basemapFollowsTheme,
  basemapOverrideUrl,
  resolveBasemapUrl,
  resolveBasemapKind,
  resolveBasemapAttribution,
  type BasemapKey,
  type BasemapKind,
  type AttributionLine,
} from "@/lib/basemap";
import type { LayerStyle } from "@/lib/style/style";
import {
  effectiveStyle,
  isAggregated,
  isOdViz,
  type LayerViz,
  type LegendAttrs,
} from "@/lib/viz";
import { liveFilters, liveDim, type LiveDim } from "@/lib/live-filters";
import { isBoundedOutcome } from "@/lib/query/bounded";
import { limits } from "@/lib/limits";
import type { MapWidget } from "@/lib/widgets";
import { generateToken } from "./token";

export interface PublishState {
  token: string;
  publishedAt: string;
}

/** The active publication's authored settings. The author
 * surface reads this: a map record deliberately carries no publication
 * state, so without it the publish surface could not show the default it
 * is about to change. */
export interface PublicationState extends PublishState {
  theme: PublishedTheme;
  viewerControls: ViewerControls;
}

/** What a publish call may state. Each field is independently optional,
 * and that independence is load-bearing: the builder's workspace-theme
 * sync states a theme and nothing else, and must never re-enable
 * controls the author unchecked. */
export interface PublishSettings {
  theme?: PublishedTheme;
  viewerControls?: Partial<ViewerControls>;
}

/** Read an active publication's settings, or null when the map is not
 * published. Normalizing here — not at each surface — is what keeps a
 * earlier publication, an unstated setting and an omitted member all
 * reading as every control on. */
export function getPublicationState(scope: AccountScope, id: string): PublicationState | null {
  const map = requirePublishedMapOwner(scope, id);
  if (!map.publishToken || !map.publishedAt) return null;
  return {
    token: map.publishToken,
    publishedAt: map.publishedAt,
    theme: getPublishedTheme(id) ?? "dark",
    viewerControls: normalizeViewerControls(getViewerControls(id)),
  };
}

function requirePublishedMapOwner(scope: AccountScope, id: string) {
  return requireMap(scope, id);
}

/** Publish a map, or return the existing link unchanged if already published
 * (spec: one active link per map; republish returns the same URL). The
 * authored theme is captured here: stated wins; omitted reads dark on a
 * first publication and changes nothing on an active one. A stated mode
 * on an active publication updates the stored default in place — the link
 * is the contract and the token never moves for a theme. The viewer
 * controls follow the same in-place rule, and the two settings are tested
 * for presence independently: a call stating only a theme leaves the
 * checklist exactly as the author left it. */
export function publishMap(
  scope: AccountScope,
  id: string,
  settings: PublishSettings = {},
): PublishState {
  return metadataDb().transaction(() => {
    const map = requirePublishedMapOwner(scope, id);
    const { theme, viewerControls } = settings;
    if (map.publishToken && map.publishedAt) {
      if (theme) setPublishedTheme(id, theme);
      if (viewerControls) {
        setViewerControls(id, normalizeViewerControls(viewerControls));
      }
      return { token: map.publishToken, publishedAt: map.publishedAt };
    }
    const token = generateToken();
    const publishedAt = new Date().toISOString();
    updateMapFields(id, { publishToken: token, publishedAt });
    setPublishedTheme(id, theme ?? "dark");
    // An unstated set is stored as null, which reads as every control on;
    // storing the normalized default instead would be indistinguishable
    // but says something the author never stated.
    setViewerControls(
      id,
      viewerControls ? normalizeViewerControls(viewerControls) : null,
    );
    return { token, publishedAt };
  })();
}

/** Unpublish: the link stops resolving immediately; a later republish mints a
 * fresh, unrelated token (spec: rotation is the revocation story). */
export function unpublishMap(scope: AccountScope, id: string): void {
  const token = metadataDb().transaction(() => {
    const map = requirePublishedMapOwner(scope, id);
    updateMapFields(id, { publishToken: null, publishedAt: null });
    // The authored theme is publication state: it leaves with the token,
    // so the next publication captures fresh. The viewer controls are
    // publication state too and leave with it.
    setPublishedTheme(id, null);
    setViewerControls(id, null);
    return map.publishToken;
  })();
  if (token) invalidatePublishedToken(token);
}

export interface PublishedLayer {
  id: string;
  name: string;
  /** Ready to draw: an aggregated layer's fill is already the cell fill. */
  style: LayerStyle;
  visible: boolean;
  tooltip: string[] | null;
  /** Fields for the click pop-up; null = automatic. */
  popup: string[] | null;
  inLegend: boolean;
  /** The viewer needs the viz for client-drawn types (heatmap). */
  viz: LayerViz;
  legendTitle: string | null;
  legendLabels: (string | null)[] | null;
  legendAttrs: LegendAttrs | null;
  render: LayerRenderData;
  /** The layer's live filters, resolved: the render ships
   * without them and the viewer enforces these settled ranges client-side.
   * Empty when every filter is already applied in the SQL. */
  liveFilters: LiveDim[];
}

/** Everything the viewer's timeline widget needs — resolved
 * server-side so the published page calls no further APIs. */
export interface PublishedTimeline {
  layerId: string;
  field: string;
  speed: number;
  /** The settled window — the docked filter's bounds; null = open-ended. */
  window: { min: string | null; max: string | null };
  /** Full extent of the field (ISO-8601, as stored). */
  extent: { min: string; max: string };
  /** Row counts over equal-width bins across the extent — the histogram. */
  bins: number[];
}

export interface PublishedView {
  name: string;
  viewport: Viewport;
  /** The authored default theme; a publication from before
   * reads dark until published anew. */
  theme: PublishedTheme;
  /** Resolved basemap style URL for the authored theme — the published
   * page's first render uses exactly this. */
  basemapUrl: string;
  /** Non-null when the basemap follows the effective theme (a genuine
   * Auto with no deployment override): the style for each mode, so the
   * reader toggle can swap without another round trip. Fixed choices and
   * overridden Auto stay on basemapUrl in both themes. */
  basemapForTheme: { light: string; dark: string } | null;
  /** The authored basemap choice; null = Auto. The reader's
   * picker marks its card from this and resolves a return to Auto — the
   * resolved URL alone cannot say whether Auto or an explicit style that
   * happens to share the URL was authored. */
  basemapKey: BasemapKey | null;
  /** The map's custom basemap style; null = none. When set,
   * basemapUrl is its URL in both themes, the attribution is its saved
   * snapshot, and the reader's picker marks no built-in card — a reader
   * who switches to one has no way back within the load, decided with
   * eyes open. */
  customBasemap: CustomBasemap | null;
  /** Whether this deployment pins Auto in both themes. The
   * reader's theme control leaves a pinned Auto alone; an explicit pick
   * still applies. */
  basemapPinned: boolean;
  /** The style's kind: group toggles act on vector only. */
  basemapKind: BasemapKind;
  /** The style's credit lines — the footer renders these. */
  basemapAttribution: AttributionLine[];
  /** Hidden basemap content groups; null = all visible. */
  basemapLayers: BasemapLayers | null;
  /** The map's info box; null = no box. */
  note: MapNote | null;
  /** Where the legend sits; null = bottom-left. */
  legendCorner: Corner | null;
  /** The manual legend arrangement: layer ids in legend
   * order, top first; null = automatic (follow the layer order). */
  legendOrder: string[] | null;
  /** The docked playback timeline; null = none. */
  timeline: PublishedTimeline | null;
  layers: PublishedLayer[];
  /** Visible widgets — the reader's live dashboard. Empty when
   * the map's toggle is off or no widget resolves. */
  widgets: MapWidget[];
  /** Which optional reader controls this publication exposes.
   * A publication that never stated a set reports every control on. */
  viewerControls: ViewerControls;
}

// Freshness cache: published views are live within a documented bound. A cache
// hit within the bound returns instantly; a popular link cannot melt the
// instance. Unpublish invalidates by construction.
interface CacheEntry {
  view: PublishedView;
  mapId: string;
  revision: string;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

export function invalidatePublishedToken(token: string): void {
  cache.delete(token);
}

/** Tests reset shared state. */
export function resetPublishCache(): void {
  cache.clear();
}

/**
 * Assemble the read-only view for a published token, or null if the token
 * does not resolve. Read-only by construction: this reads map/layer state and
 * renders; it never mutates. Served within the freshness bound from cache.
 */
export async function getPublishedView(
  token: string,
  now: number,
  signal?: AbortSignal,
): Promise<PublishedView | null> {
  let snapshot = getPublishedSnapshot(token);
  if (!snapshot) {
    invalidatePublishedToken(token);
    return null;
  }
  const cached = cache.get(token);
  if (
    cached &&
    cached.mapId === snapshot.map.id &&
    cached.revision === snapshot.revision &&
    now < cached.expiresAt
  ) {
    return cached.view;
  }

  // Assembly performs asynchronous queries. If durable state changes across
  // one pass, discard the mixed result and assemble again from the new
  // snapshot. Revocation returns null and can never repopulate the cache.
  while (true) {
    const { map, layers, publishedTheme, viewerControls, revision } = snapshot;
    const view = await assemblePublishedView(
      map,
      layers,
      publishedTheme,
      viewerControls,
      token,
      signal,
    );
    const current = getPublishedSnapshot(token);
    if (!current) {
      invalidatePublishedToken(token);
      return null;
    }
    if (current.map.id !== map.id || current.revision !== revision) {
      snapshot = current;
      continue;
    }
    cache.set(token, {
      view,
      mapId: map.id,
      revision,
      expiresAt: now + limits.publishFreshnessS * 1000,
    });
    return view;
  }
}

async function assemblePublishedView(
  map: ReturnType<typeof requirePublishedMapOwner>,
  layers: Layer[],
  publishedTheme: PublishedTheme | null,
  viewerControls: ViewerControls | null,
  token: string,
  signal?: AbortSignal,
): Promise<PublishedView> {
  // Published renders carry the effective published field set, not the
  // full row — the same context every published lane supplies.
  const published = {
    timeline: map.timeline,
    widgets: map.widgets,
    widgetsPublished: map.widgetsPublished,
  };
  // A hidden layer contributes no feature data to the published payload:
  // the viewer offers readers no way to see it, so its rows have no
  // reader. Widgets bound to it still ship and compute — hide the
  // geometry, keep the numbers.
  const rendered = await Promise.all(
    layers
      .filter((l) => l.visible)
      .map(async (l): Promise<PublishedLayer> => {
        const render = publishedRender(
          await renderLayer(l, signal, { published }),
          token,
          l.id,
        );
        // The render says whether it shipped without the live filters (it
        // may have fallen back to SQL); when it did, the viewer gets their
        // settled ranges to enforce.
        const dockedField =
          map.timeline?.layerId === l.id ? map.timeline.field : null;
        const live = render.liveFiltered
          ? liveFilters(l.viz, l.filters, dockedField).map(liveDim)
          : [];
        // The response never names a field the wire lacks: explicit
        // interaction lists are filtered through the effective set the
        // render carried. Automatic (null) stays automatic — the canvas
        // resolves it over what ships. An errored render carried no set
        // at all, so an explicit list ships empty: there is nothing its
        // names could describe.
        const shipped = (list: string[] | null) =>
          list === null
            ? null
            : list.filter((f) => render.publishedFields?.includes(f) ?? false);
        // Origin/destination mappings are consumed server-side — the
        // published line geometry already embodies them. Their column
        // names stay off the anonymous wire; the
        // viewer draws from the geometry and never reads endpoints.
        const publishedViz = isOdViz(l.viz)
          ? { ...l.viz, origin: null, dest: null }
          : l.viz;
        return {
          id: l.id,
          name: l.name,
          style: effectiveStyle(l.style, l.viz),
          visible: l.visible,
          tooltip: shipped(l.tooltip),
          popup: shipped(l.popup),
          inLegend: l.inLegend,
          viz: publishedViz,
          legendTitle: l.legendTitle,
          legendLabels: l.legendLabels,
          legendAttrs: l.legendAttrs,
          render,
          liveFilters: live,
        };
      }),
  );

  // The authored default: earlier publications read dark. A
  // theme-following Auto basemap resolves by that default for the first
  // render and ships both outcomes for the reader toggle; explicit choices
  // and overridden Auto stay fixed. Kind and attribution need no per-theme
  // variants — Auto only moves between the bundled OpenFreeMap vector
  // styles, which share both.
  const theme = publishedTheme ?? "dark";
  // A custom style wins outright and is fixed in both themes; absent one,
  // every existing key/Auto rule stands unchanged. Its credit is the
  // snapshot captured at save time — the only truthful line when the
  // style itself cannot be read later — never the OpenFreeMap fallback.
  // Kind reads as vector so the group toggles stay live for whatever
  // groups the loaded style actually yields.
  const custom = map.customBasemap;
  const followsTheme = !custom && basemapFollowsTheme(map.basemap);
  return {
    name: map.name,
    viewport: map.viewport,
    theme,
    basemapUrl: custom
      ? custom.url
      : followsTheme
        ? autoBasemapUrlForTheme(theme)
        : resolveBasemapUrl(map.basemap),
    basemapForTheme: followsTheme
      ? {
          light: autoBasemapUrlForTheme("light"),
          dark: autoBasemapUrlForTheme("dark"),
        }
      : null,
    basemapKey: map.basemap,
    customBasemap: custom,
    basemapPinned: basemapOverrideUrl() !== null,
    basemapKind: custom ? "vector" : resolveBasemapKind(map.basemap),
    basemapAttribution: custom
      ? custom.attribution
      : resolveBasemapAttribution(map.basemap),
    basemapLayers: map.basemapLayers,
    note: map.note,
    legendCorner: map.legendCorner,
    legendOrder: map.legendOrder,
    timeline: await publishedTimeline(map.timeline, layers, signal),
    layers: rendered,
    // A widget whose layer drifted away degrades to absence, never an
    // error — the published page must keep rendering (the rule). Notes
    // carry no layer and always ship when visible.
    widgets: map.widgetsPublished
      ? map.widgets.filter(
          (w) =>
            w.visible &&
            (w.layerId === null || layers.some((l) => l.id === w.layerId)),
        )
      : [],
    viewerControls: normalizeViewerControls(viewerControls),
  };
}

/**
 * Resolve the map's docked timeline for the viewer. A dock that no longer
 * resolves — the layer, the filter, or the field's temporal kind drifted
 * since docking — degrades to no timeline, never to an error: the published
 * page must keep rendering.
 */
async function publishedTimeline(
  timeline: MapTimeline | null,
  layers: Layer[],
  signal?: AbortSignal,
): Promise<PublishedTimeline | null> {
  if (!timeline) return null;
  const layer = layers.find((l) => l.id === timeline.layerId);
  // A hidden layer's timeline would scrub data no reader can see — its
  // extent and bins are that data's shape, so the dock degrades away with
  // it.
  if (!layer || !layer.visible || isAggregated(layer.viz)) return null;
  const filter = layer.filters.find(
    (f) => f.kind === "timerange" && f.field === timeline.field,
  );
  if (!filter || filter.kind !== "timerange") return null;
  try {
    const stats = await layerFieldStats(layer, timeline.field, signal);
    if (stats.kind !== "time" || stats.min == null || stats.max == null) {
      return null;
    }
    return {
      layerId: timeline.layerId,
      field: timeline.field,
      speed: timeline.speed,
      window: { min: filter.min, max: filter.max },
      extent: { min: stats.min, max: stats.max },
      bins: stats.bins,
    };
  } catch (error) {
    // The bound's outcomes are the request's, not a drift to degrade away;
    // a timeline has no errored state of its own to show them in.
    if (isBoundedOutcome(error)) throw error;
    return null; // a broken layer query already shows as an errored layer
  }
}

/** The published wire carries only documented prose: an errored envelope crossing the published boundary
 * keeps its code but has its message replaced by the catalogue sentence.
 * The builder keeps the raw text — the author's diagnostic for their own
 * SQL, on the authenticated-equivalent surface. */
export function sanitizePublishedRender(
  render: LayerRenderData,
): LayerRenderData {
  if (render.ok || !render.error) return render;
  return {
    ...render,
    error: {
      code: render.error.code,
      message: publishedMessage(render.error.code),
    },
  };
}

/** A published page fetches tiles under its token, not the builder path
 * rewrite a tiled render's URL template, keeping the cache-busting
 * version. */
function publishedRender(
  render: LayerRenderData,
  token: string,
  layerId: string,
): LayerRenderData {
  render = sanitizePublishedRender(render);
  if (!render.ok || !render.tiles?.url) return render;
  const version = render.tiles.url.split("?")[1];
  return {
    ...render,
    tiles: {
      ...render.tiles,
      url: `/api/published/${token}/tiles/${layerId}/{z}/{x}/{y}${
        version ? `?${version}` : ""
      }`,
    },
  };
}

/** Guard used by mutation endpoints: a published token never authorizes a
 * write. Kept explicit so the read-only guarantee is testable. */
export function assertNotUsingPublishTokenAsAuth(id: string): void {
  // Map ids and publish tokens are distinct namespaces; a token is never a
  // valid map id for mutation. Present for clarity and future-proofing.
  if (getMapByToken(id) && !getMap(id)) {
    throw new ApiError("not_found", "No such map.", 404);
  }
}
