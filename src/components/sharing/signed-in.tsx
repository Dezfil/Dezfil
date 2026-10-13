"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PersonLabel } from "./people";
import { DepartureNoticeProvider } from "../projects/departure-notice";

/**
 * Who is signed in, as the workspace shell read it on the server when the
 * page was served: the display name and the SQL name, nothing else. The
 * lists compare an item's owner with it to mark someone else's work; the
 * shell is keyed by the account, so a switch remounts everything under it.
 * Outside the shell nobody is known and nothing is marked.
 */
const SignedInContext = createContext<PersonLabel | null>(null);

export function SignedIn({
  account,
  children,
}: {
  account: PersonLabel | null;
  children: ReactNode;
}) {
  return (
    <SignedInContext.Provider value={account}>
      <DepartureNoticeProvider key={account?.sqlName ?? ""}>{children}</DepartureNoticeProvider>
    </SignedInContext.Provider>
  );
}

/** The signed-in person's SQL name, or null when unknown. */
export function useSignedInSqlName(): string | null {
  return useContext(SignedInContext)?.sqlName ?? null;
}

/** The signed-in person's display name and SQL name, as the shell read
 * them, or null when unknown. */
export function useSignedInLabel(): PersonLabel | null {
  return useContext(SignedInContext);
}
