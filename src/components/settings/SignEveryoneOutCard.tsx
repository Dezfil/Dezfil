"use client";
import { useState } from "react";
import { accountChanged } from "@/components/auth/private-state";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountRequest, failureMessage } from "./api";
import { SIGN_OUT_CARD } from "./security-table";
import { CardActions, Note, SettingsCard } from "./SettingsCard";
import cardStyles from "./SettingsCard.module.css";

/** Security's Sign everyone out: asked first, in the words of what ends. The
 * admin's own session ends with the rest, so an answer goes to the sign-in page. */
export function SignEveryoneOutCard() {
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!busy) { setAsking(false); setError(null); } };
  async function signOut() {
    setBusy(true); setError(null);
    try {
      await accountRequest("/api/instance/sign-out", "POST");
      accountChanged();
      window.location.replace(new URL("/sign-in", window.location.origin).href);
    } catch (failure) { setError(failureMessage(failure)); setBusy(false); }
  }
  return <SettingsCard id={SIGN_OUT_CARD.id} title={SIGN_OUT_CARD.title} headingId="security-sign-out-heading">
    <Note>Ends every session and API token of every account, yours included.</Note>
    <CardActions><Button variant="danger" onClick={() => setAsking(true)}>Sign everyone out</Button></CardActions>
    {asking && <Dialog label="Sign everyone out" className={cardStyles.dialog} onClose={close}>
      <h2>Sign everyone out?</h2>
      <p>Every session and API token of every account ends, your own included. Running assistant work stops and parked runs end.</p>
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <CardActions>
        <Button variant="danger" busy={busy} onClick={() => void signOut()}>Sign everyone out</Button>
        <Button disabled={busy} onClick={close}>Cancel</Button>
      </CardActions>
    </Dialog>}
  </SettingsCard>;
}
