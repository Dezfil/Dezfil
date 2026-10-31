"use client";
import { useEffect, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { readExternalMode } from "@/components/auth/external-mode";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { AccountCard } from "./AccountCard";
import { failureMessage } from "./api";
import { useDrawn } from "./settings-land";
import cardStyles from "./SettingsCard.module.css";

/** Account: the card, once the sign-in mode is known. The tab reads out of
 * sight until then, and a read that fails says so with its retry, so no email
 * or password field shows where the mode may refuse it. */
export function AccountTab({ account }: { account: Account }) {
  const [external, setExternal] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readExternalMode().then(value => {
      if (!cancelled) { setExternal(value); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  useDrawn(external !== null || error !== null);
  if (error) return <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />;
  if (external === null) return <p role="status" className={cardStyles.loading}>Loading…</p>;
  return <AccountCard account={account} external={external} />;
}
