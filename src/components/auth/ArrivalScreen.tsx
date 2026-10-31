"use client";
import { useEffect, useRef, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountRequest, failureMessage } from "@/components/settings/api";
import { landingRoute } from "./entry-settings";
import { EntryStage } from "./EntryStage";
import { accountChanged } from "./private-state";
import { StartSignIn } from "./StartSignIn";
import styles from "./EntryScreen.module.css";

interface Entry { instanceName: string | null; landingPage?: string | null }
type Arrival = { state: "arriving" } | { state: "refused"; message: string } | { state: "signed-in"; account: Account };

const NO_TICKET = "This sign-in link is unavailable. Start sign-in again.";
const UNREACHABLE = "This instance could not be reached. Start sign-in again.";

/** The refusal in the words the person reads. */
function refusal(error: { code?: string; message?: string; retryAt?: string } | undefined): string {
  if (error?.code === "rate_limited" && error.retryAt) return `Too many sign-in attempts. Try again at ${new Date(error.retryAt).toLocaleTimeString()}.`;
  return error?.message ?? "This sign-in could not be completed. Start sign-in again.";
}

const readEntry = () => fetch("/api/auth/entry", { cache: "no-store" })
  .then(response => response.ok ? response.json() as Promise<Entry> : null).catch(() => null);

/**
 * The page the sign-in service returns the browser to, with the ticket in
 * the address's fragment. It takes the ticket out of the address, hands it
 * to the arrival operation once and lands where a sign-in lands. A browser
 * that already holds a session keeps it: the page names that account and
 * offers to sign out. Every other refusal is shown in the server's words,
 * with the way to start again.
 */
export function ArrivalScreen() {
  const [arrival, setArrival] = useState<Arrival>({ state: "arriving" });
  const [entry, setEntry] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const began = useRef(false);
  useEffect(() => {
    // A ticket is single-use, so a second run of this effect must not spend it again.
    if (began.current) return;
    began.current = true;
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get("ticket");
    window.history.replaceState(window.history.state, "", window.location.pathname);
    const read = readEntry().then(value => { setEntry(value); return value; });
    void (async () => {
      if (!ticket) { setArrival({ state: "refused", message: NO_TICKET }); return; }
      try {
        const response = await fetch("/api/auth/external/arrive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }), cache: "no-store" });
        if (response.ok) {
          accountChanged();
          const place = await read;
          window.location.replace(new URL(landingRoute(place?.landingPage), window.location.origin).href);
          return;
        }
        const error = (await response.json().catch(() => null))?.error;
        setArrival(error?.code === "already_signed_in" && error.account ? { state: "signed-in", account: error.account } : { state: "refused", message: refusal(error) });
      } catch { setArrival({ state: "refused", message: UNREACHABLE }); }
    })();
  }, []);
  async function signOut() {
    setBusy(true); setFailure(null);
    try {
      await accountRequest("/api/auth/sign-out", "POST");
      accountChanged();
      window.location.replace(new URL("/sign-in", window.location.origin).href);
    } catch (error) { setFailure(failureMessage(error)); setBusy(false); }
  }
  return <EntryStage instance={entry?.instanceName ?? null} subtitle="Maps, data and SQL on this instance.">
    {arrival.state === "arriving" && <div className={styles.heading} role="status"><h1>Signing you in…</h1></div>}
    {arrival.state === "refused" && <>
      <div className={styles.heading}><h1>Sign-in did not finish</h1></div>
      <ErrorNote message={arrival.message} />
      <StartSignIn label="Start again" />
    </>}
    {arrival.state === "signed-in" && <>
      <div className={styles.heading}><h1>You are already signed in</h1>
        <p className={styles.help}>This browser is signed in as {arrival.account.name} ({arrival.account.email}). Sign out to continue with another account.</p>
      </div>
      {failure && <ErrorNote message={failure} onRetry={() => void signOut()} onDismiss={() => setFailure(null)} />}
      <div className={styles.form}>
        <Button variant="primary" size="chrome" busy={busy} className={styles.submit} onClick={() => void signOut()}>Sign out</Button>
        <Button variant="quiet" size="chrome" disabled={busy} className={styles.submit} onClick={() => window.location.replace(new URL(landingRoute(entry?.landingPage), window.location.origin).href)}>Stay signed in</Button>
      </div>
    </>}
  </EntryStage>;
}
