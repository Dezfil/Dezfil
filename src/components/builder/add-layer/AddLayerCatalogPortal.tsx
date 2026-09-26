"use client";

import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import { AddLayerCatalog } from "./AddLayerCatalog";

/** The catalog is builder state rendered at the document modal boundary.
 * Keeping that portal ownership here prevents MapBuilder from growing every
 * time the catalog gains another coordinator handoff. */
export function AddLayerCatalogPortal({
  portalRoot,
  ...catalog
}: ComponentProps<typeof AddLayerCatalog> & { portalRoot: Element }) {
  return createPortal(<AddLayerCatalog {...catalog} />, portalRoot);
}
