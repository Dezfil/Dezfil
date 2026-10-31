"use client";
import { useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import styles from "./UsersScreen.module.css";

/** A link to pass on, or, with a sign-in service, none at all. */
export type HandOver = { account: Account; signInUrl: string; expiresAt: string } | { account: Account; signInUrl?: undefined; expiresAt?: undefined };
type LinkHandOverValue = Extract<HandOver, { signInUrl: string }>;

/** An invited person's way in, with a sign-in service: where, and with which email. */
export const signsInAtTheService = (email: string) => `They sign in at the sign-in service with ${email}. There is no link to send.`;

export function SignInHandOver({ value, onDone }: { value: HandOver; onDone: () => void }) {
  if (value.signInUrl) return <LinkHandOver value={value} onDone={onDone} />;
  return <div className={styles.handOver}>
    <p className={styles.note}>{signsInAtTheService(value.account.email)}</p>
    <div className={styles.actions}><Button variant="primary" onClick={onDone}>Done</Button></div>
  </div>;
}

function LinkHandOver({ value, onDone }: { value: LinkHandOverValue; onDone: () => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState<string | null>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(value.signInUrl); setCopied(true); }
    catch { setError("The link could not be copied. Select it and copy it manually."); }
  }
  return <div className={styles.handOver}>
    <label className={styles.field}><span>Sign-in link</span><TextInput readOnly value={value.signInUrl} autoComplete="off"
      onFocus={event => event.target.select()} /></label>
    <p className={styles.note}>Shown once. No email is sent; share this link privately.</p>
    <p className={styles.note}>Expires {new Date(value.expiresAt).toLocaleString()}.</p>
    {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
    <div className={styles.actions}><Button onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Button><Button variant="primary" onClick={onDone}>Done</Button></div>
  </div>;
}
