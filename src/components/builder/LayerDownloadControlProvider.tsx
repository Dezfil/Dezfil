"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

const LayerDownloadPreparationTimeoutContext = createContext<
  number | undefined
>(undefined);

export function LayerDownloadControlProvider({
  preparationTimeoutMs,
  children,
}: {
  preparationTimeoutMs: number;
  children: ReactNode;
}) {
  if (!Number.isFinite(preparationTimeoutMs) || preparationTimeoutMs <= 0) {
    throw new RangeError(
      "The layer-download preparation timeout must be positive.",
    );
  }
  return (
    <LayerDownloadPreparationTimeoutContext.Provider value={preparationTimeoutMs}>
      {children}
    </LayerDownloadPreparationTimeoutContext.Provider>
  );
}

export function useLayerDownloadPreparationTimeoutMs(): number {
  const timeoutMs = useContext(LayerDownloadPreparationTimeoutContext);
  if (timeoutMs === undefined) {
    throw new Error(
      "useLayerDownloadPreparationTimeoutMs must be used within LayerDownloadControlProvider.",
    );
  }
  return timeoutMs;
}
