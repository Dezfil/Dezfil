"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { ApiToken } from "@/lib/metadata/auth-credentials";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Dialog } from "@/components/ui/Dialog";
import { accountRequest, failureMessage } from "./api";
import styles from "../SettingsScreen.module.css";

export function TokensCard() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null), [attempt, setAttempt] = useState(0);
  const [name, setName] = useState(""), [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [revoking, setRevoking] = useState<ApiToken | null>(null);
  useEffect(() => {
    let cancelled = false;
    accountRequest<{ tokens: ApiToken[] }>("/api/account/tokens").then(body => {
      if (!cancelled) { setTokens(body.tokens); setError(null); }
    }).catch(error => { if (!cancelled) setError(failureMessage(error)); });
    return () => { cancelled = true; };
  }, [attempt]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const created = await accountRequest<ApiToken & { secret: string }>("/api/account/tokens", "POST", { name });
      const { secret: disclosed, ...token } = created;
      setTokens(current => [...(current ?? []), token]); setSecret(disclosed); setCopied(false); setName("");
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (!revoking) return;
    setBusy(true); setError(null);
    try {
      await accountRequest(`/api/account/tokens/${encodeURIComponent(revoking.id)}`, "DELETE");
      setTokens(current => current?.map(token => token.id === revoking.id ? { ...token, revokedAt: new Date().toISOString() } : token) ?? null);
      setRevoking(null);
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(secret!); setCopied(true); }
    catch { setError("The token could not be copied. Select it and copy it manually."); }
  }
  return <section className={styles.card} aria-labelledby="tokens-heading">
    <h2 id="tokens-heading">API / MCP tokens</h2>
    <p className={styles.note}>Tokens use your current access, including shared projects.</p>
    {error && !revoking && <ErrorNote message={error} onRetry={tokens === null ? () => setAttempt(value => value + 1) : undefined}
      onDismiss={tokens === null ? undefined : () => setError(null)} />}
    {secret ? <div className={styles.cardForm}>
      <label className={styles.field}><span>New token</span><TextInput readOnly value={secret} onFocus={event => event.target.select()} autoComplete="off" /></label>
      <p className={styles.note}>Copy this token now. It will not be shown again.</p>
      <div className={styles.actions}><Button onClick={() => void copy()}>{copied ? "Copied" : "Copy token"}</Button>
        <Button onClick={() => { setSecret(null); setCopied(false); }}>Done</Button></div>
    </div> : <form className={styles.cardForm} onSubmit={create}>
      <label className={styles.field}><span>Token name</span><TextInput value={name} onChange={event => setName(event.target.value)} required disabled={busy || tokens === null} /></label>
      <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || tokens === null}>Create token</Button>
    </form>}
    {tokens === null && !error && <p role="status" className={styles.note}>Loading tokens…</p>}
    {tokens?.length === 0 && <p className={styles.note}>No tokens yet.</p>}
    <ul className={styles.tokenList}>{tokens?.map(token => <li key={token.id} className={styles.tokenRow}>
      <div><strong>{token.name}</strong><p className={styles.note}>{token.revokedAt ? "Revoked" : token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "Never used"}</p></div>
      {!token.revokedAt && <Button disabled={busy} onClick={() => { setError(null); setRevoking(token); }} aria-label={`Revoke ${token.name}`}>Revoke</Button>}
    </li>)}</ul>
    {revoking && <Dialog label={`Revoke ${revoking.name}`} onClose={() => { if (!busy) { setRevoking(null); setError(null); } }}>
      <div className={styles.cardForm}><h2>Revoke {revoking.name}?</h2><p>Clients using this token will lose access.</p>
        {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
        <div className={styles.actions}><Button variant="danger" busy={busy} onClick={() => void revoke()}>Revoke token</Button>
          <Button disabled={busy} onClick={() => { setRevoking(null); setError(null); }}>Cancel</Button></div>
      </div>
    </Dialog>}
  </section>;
}
