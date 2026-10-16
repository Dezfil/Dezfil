/**
 * One effective-basemap derivation for every host — the builder canvas,
 * the published view's assembly, the export preview and the server
 * export page previously each restated it. A custom style wins outright
 * and is fixed in both themes; absent one, the existing rules stand
 * unchanged: an explicit key is itself, Auto follows the theme unless
 * the deployment override pins it. Custom kind reads as vector so the
 * group toggles stay live for whatever groups the loaded style actually
 * yields; custom credit is the saved snapshot, never the OpenFreeMap
 * fallback. A key the instance does not draw (Satellite removed, or its
 * template unreadable) draws the deployment default and claims that
 * default's credit, as the server credits it. Dependency-free beyond the
 * basemap domain — reaches the client bundle.
 */

import {
  BASEMAPS,
  BUILT_IN_ATTRIBUTION,
  type AttributionLine,
  type BasemapStyle,
  type BasemapKey,
  type BasemapKind,
} from "./basemap";
import type { CustomBasemap } from "./metadata/maps";

export interface EffectiveBasemap {
  url: string;
  kind: BasemapKind;
  attribution: AttributionLine[];
  /** True when the custom style decided the answer. */
  custom: boolean;
  /** True when the answer follows the theme: a genuine Auto —
   * no custom style, no key, no deployment override. Such a map carries
   * one card image per theme; every other map keeps one. */
  followsTheme: boolean;
}

/** Whether the basemap a map draws is light or dark, for what is drawn
 * straight onto it with no card of its own, so it reads against the map
 * rather than the page. The Dark and Light styles are the two tones
 * themselves, Streets is a light style in both themes, and Auto follows the
 * theme. A custom style wins over the key it was put on; it, Satellite and
 * a deployment's own style carry no tone here, so they take the theme's. */
export function basemapTone(args: {
  key: BasemapKey | null;
  /** Whether a custom style is drawn, which wins over the key. */
  custom: boolean;
  theme: "light" | "dark";
}): "light" | "dark" {
  if (args.custom) return args.theme;
  if (args.key === "dark" || args.key === "light") return args.key;
  if (args.key === "streets") return "light";
  return args.theme;
}

/** What a basemap picker says on a map on Satellite where this instance
 * draws no imagery (none set up, or its template unreadable): the map is
 * drawn on the deployment default instead, and credited as that default. */
export const IMAGERY_MISSING_NOTE =
  "No satellite imagery is available on this instance, so this map shows the default style.";

/** Whether a map's choice is Satellite while this instance draws no
 * imagery. A style hidden from the pickers is still drawn, so it counts as
 * there; a custom style wins over the key, so under one nothing is missing. */
export function imageryMissing(args: {
  key: BasemapKey | null;
  custom: boolean;
  basemaps: BasemapStyle[];
}): boolean {
  return !args.custom && args.key === "satellite" && !args.basemaps.some((b) => b.key === "satellite");
}

/** The deployment default's credit: the deployment style's configured
 * credit when it sets one (none configured claims nothing), else the
 * built-in credit. */
function defaultCredit(overrideUrl: string | null, overrideAttribution: AttributionLine[] | undefined): AttributionLine[] {
  return overrideUrl ? (overrideAttribution ?? []) : BUILT_IN_ATTRIBUTION;
}

export function effectiveBasemap(args: {
  key: BasemapKey | null;
  custom: CustomBasemap | null;
  /** The theme Auto follows. */
  theme: "light" | "dark";
  /** Deployment override (DEZFIL_BASEMAP_URL), server-injected. */
  overrideUrl: string | null;
  /** The deployment default, server-injected — the last resort. */
  defaultUrl: string;
  /** The styles this instance offers. Defaults to the built-in three;
   * hosts that know whether imagery is configured pass their own list,
   * server-injected, so a satellite map resolves to its style. */
  basemaps?: BasemapStyle[];
  /** The credit for a deployment override, server-injected. Absent, an
   * override claims nothing rather than crediting the built-in provider. */
  overrideAttribution?: AttributionLine[];
}): EffectiveBasemap {
  const { key, custom, theme, overrideUrl, defaultUrl } = args;
  const basemaps = args.basemaps ?? BASEMAPS;
  if (custom) {
    return {
      url: custom.url,
      kind: "vector",
      attribution: custom.attribution,
      custom: true,
      followsTheme: false,
    };
  }
  if (key) {
    const chosen = basemaps.find((b) => b.key === key);
    return {
      url: chosen?.url ?? defaultUrl,
      kind: chosen?.kind ?? "vector",
      attribution: chosen?.attribution ?? defaultCredit(overrideUrl, args.overrideAttribution),
      custom: false,
      followsTheme: false,
    };
  }
  return {
    url:
      overrideUrl ??
      (basemaps.find((b) => b.key === theme)?.url ?? defaultUrl),
    kind: "vector",
    attribution: defaultCredit(overrideUrl, args.overrideAttribution),
    custom: false,
    followsTheme: overrideUrl === null,
  };
}
