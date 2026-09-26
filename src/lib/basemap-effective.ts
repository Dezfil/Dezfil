/**
 * One effective-basemap derivation for every host — the builder canvas,
 * the published view's assembly, the export preview and the server
 * export page previously each restated it. A custom style wins outright
 * and is fixed in both themes; absent one, the existing rules stand
 * unchanged: an explicit key is itself, Auto follows the theme unless
 * the deployment override pins it. Custom kind reads as vector so the
 * group toggles stay live for whatever groups the loaded style actually
 * yields; custom credit is the saved snapshot, never the OpenFreeMap
 * fallback. Dependency-free beyond the basemap domain — reaches the
 * client bundle.
 */

import {
  BASEMAPS,
  resolveBasemapAttribution,
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
      attribution: chosen?.attribution ?? [],
      custom: false,
      followsTheme: false,
    };
  }
  return {
    url:
      overrideUrl ??
      (basemaps.find((b) => b.key === theme)?.url ?? defaultUrl),
    kind: "vector",
    attribution: overrideUrl
      ? (args.overrideAttribution ?? [])
      : resolveBasemapAttribution(null),
    custom: false,
    followsTheme: overrideUrl === null,
  };
}
