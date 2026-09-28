"use client";
import { useEffect, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { ErrorNote } from "./ui/ErrorNote";
import { AccountCard } from "./settings/AccountCard";
import { TokensCard } from "./settings/TokensCard";
import { WorkspaceCard } from "./settings/WorkspaceCard";
import { accountRequest, failureMessage } from "./settings/api";
import styles from "./SettingsScreen.module.css";

export function SettingsScreen() {
  const [loaded, setLoaded] = useState<{ account: Account; instanceName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      accountRequest<{ account: Account }>("/api/account"),
      accountRequest<{ instanceName: string | null }>("/api/settings"),
    ]).then(([identity, settings]) => {
      if (!cancelled) { setLoaded({ account: identity.account, instanceName: settings.instanceName }); setError(null); }
    }).catch(error => { if (!cancelled) setError(failureMessage(error)); });
    return () => { cancelled = true; };
  }, [attempt]);
  return <div className={styles.screen}>
    <div className={styles.heading}><h1>Settings</h1></div>
    {error && <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />}
    {!loaded && !error && <p role="status">Loading settings…</p>}
    {loaded && <>
      <WorkspaceCard name={loaded.instanceName} admin={loaded.account.isAdmin} />
      <div className={styles.accountGrid}><AccountCard account={loaded.account} /><TokensCard /></div>
    </>}
  </div>;
}
