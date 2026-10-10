"use client";

import { useEffect, useState } from "react";
import type { LibraryStyleOffer } from "@/lib/basemap";

/** A style the runtime read offers, as the picker takes it: anything else
 * in the answer is left out rather than drawn. */
function isOffer(value: unknown): value is LibraryStyleOffer {
  const style = value as Partial<LibraryStyleOffer> | null;
  return typeof style?.id === "string" && typeof style.name === "string" && typeof style.url === "string" && Array.isArray(style.attribution);
}

export interface LibraryStyles {
  /** The styles the instance's basemap library offers. */
  offered: LibraryStyleOffer[];
  /** Whether a map may take a style address the library does not offer. */
  singleMapStyles: boolean;
}

/**
 * The styles the instance's basemap library offers and whether a map may
 * take any other style address, from the runtime read, read once per
 * mount. Until it answers, and for good when it fails, the picker draws
 * its built-in styles and the paste control as it always has: the server
 * refuses an address it does not take whatever the control says.
 */
export function useLibraryStyles(): LibraryStyles {
  const [library, setLibrary] = useState<LibraryStyles>({ offered: [], singleMapStyles: true });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : null))
      .then((config: { basemapStyles?: unknown; singleMapStyles?: unknown } | null) => {
        if (cancelled || !config) return;
        const offered = Array.isArray(config.basemapStyles) ? config.basemapStyles.filter(isOffer) : [];
        setLibrary({ offered, singleMapStyles: config.singleMapStyles !== false });
      })
      .catch(() => { /* without the read the picker offers the built-in styles */ });
    return () => { cancelled = true; };
  }, []);
  return library;
}
