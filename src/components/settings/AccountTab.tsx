"use client";
import { useEffect, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { readExternalMode } from "@/components/auth/external-mode";
import { AccountCard } from "./AccountCard";
import { useDrawn } from "./settings-land";
import cardStyles from "./SettingsCard.module.css";

/** Account: the card, once the sign-in mode is known. The tab reads out of
 * sight until then, so no password field shows where none is taken. */
export function AccountTab({ account }: { account: Account }) {
  const [external, setExternal] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readExternalMode().then(value => { if (!cancelled) setExternal(value); });
    return () => { cancelled = true; };
  }, []);
  useDrawn(external !== null);
  if (external === null) return <p role="status" className={cardStyles.loading}>Loading…</p>;
  return <AccountCard account={account} external={external} />;
}
