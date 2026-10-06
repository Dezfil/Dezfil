"use client";
import { useEffect, useState } from "react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountRequest, failureMessage } from "./api";
import { useInstanceRead } from "./instance-read";
import type { Value } from "./save-unit";
import { SignInCard } from "./SignInCard";
import { WorkspaceCard } from "./WorkspaceCard";
import styles from "./SettingsCard.module.css";

interface EntryRead {
  instanceName: string | null;
  signInMessage: Value;
  lostPasswordContact: Value;
  landingPage: Value;
}

/** General: the Instance card and the Sign-in card. An admin's come from
 * the configuration read and save through its write; a member, whom that
 * read refuses, sees the entry screen's values disabled. */
export function GeneralTab({ admin }: { admin: boolean }) {
  return admin ? <AdminGeneral /> : <MemberGeneral />;
}

function AdminGeneral() {
  const { read, error, retry } = useInstanceRead();
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={styles.loading}>Loading settings…</p>;
  return <>
    <WorkspaceCard admin setting={read.settings.instanceName} />
    <SignInCard admin settings={read.settings} />
  </>;
}

function MemberGeneral() {
  const [entry, setEntry] = useState<EntryRead | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    accountRequest<EntryRead>("/api/auth/entry").then(body => {
      if (!cancelled) { setEntry(body); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (error) return <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />;
  if (!entry) return <p role="status" className={styles.loading}>Loading settings…</p>;
  return <>
    <WorkspaceCard admin={false} name={entry.instanceName} />
    <SignInCard admin={false} values={{ signInMessage: entry.signInMessage, lostPasswordContact: entry.lostPasswordContact, landingPage: entry.landingPage }} />
  </>;
}
