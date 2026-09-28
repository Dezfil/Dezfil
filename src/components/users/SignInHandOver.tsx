"use client";
import { useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import styles from "./UsersScreen.module.css";

export interface HandOver { account: Account; signInUrl: string; expiresAt: string; }
export function SignInHandOver({ value, onDone }: { value: HandOver; onDone: () => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState<string | null>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(value.signInUrl); setCopied(true); }
    catch { setError("The link could not be copied. Select it and copy it manually."); }
  }
  return <div className={styles.handOver}>
    <label className={styles.field}><span>Sign-in link</span><TextInput readOnly value={value.signInUrl} autoComplete="off"
      onFocus={event => event.target.select()} /></label>
    <p className={styles.note}>They choose a password when they open it. Shown once. This instance sends no email, so share it yourself.</p>
    <p className={styles.note}>Expires {new Date(value.expiresAt).toLocaleString()}.</p>
    {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
    <div className={styles.actions}><Button onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Button><Button variant="primary" onClick={onDone}>Done</Button></div>
  </div>;
}
