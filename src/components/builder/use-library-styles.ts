"use client";

import { useEffect, useState } from "react";
import type { LibraryStyleOffer } from "@/lib/basemap";

/** A style the runtime read offers, as the picker takes it: anything else
 * in the answer is left out rather than drawn. */
function isOffer(value: unknown): value is LibraryStyleOffer {
  const style = value as Partial<LibraryStyleOffer> | null;
  return typeof style?.id === "string" && typeof style.name === "string" && typeof style.url === "string" && Array.isArray(style.attribution);
}

/**
 * The styles the instance's basemap library offers, from the runtime read,
 * read once per mount: none until it answers, and none for good when it
 * fails, so the picker draws its built-in styles as it always has.
 */
export function useLibraryStyles(): LibraryStyleOffer[] {
  const [styles, setStyles] = useState<LibraryStyleOffer[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : null))
      .then((config: { basemapStyles?: unknown } | null) => {
        const offered = config?.basemapStyles;
        if (!cancelled && Array.isArray(offered)) setStyles(offered.filter(isOffer));
      })
      .catch(() => { /* without the read the picker offers the built-in styles */ });
    return () => { cancelled = true; };
  }, []);
  return styles;
}
