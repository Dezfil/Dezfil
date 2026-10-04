"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const DepartureNotice = createContext<{ notice: string | null; remember: (notice: string) => void; clear: () => void }>({
  notice: null, remember: () => {}, clear: () => {},
});

/** A one-visit outcome carried from the home to Projects inside the account's
 * shell. No project names are placed in the URL or persisted across sign-out. */
export function DepartureNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, remember] = useState<string | null>(null);
  const clear = useCallback(() => remember(null), []);
  const value = useMemo(() => ({ notice, remember, clear }), [notice, clear]);
  return <DepartureNotice.Provider value={value}>{children}</DepartureNotice.Provider>;
}

export const useDepartureNotice = () => useContext(DepartureNotice);
