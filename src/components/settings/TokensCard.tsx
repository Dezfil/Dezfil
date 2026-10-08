"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { ApiToken } from "@/lib/metadata/auth-credentials";
import { ruleRefusal } from "@/lib/settings/instance-rules";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Dialog } from "@/components/ui/Dialog";
import { accountRequest, failureMessage } from "./api";
import { useGuardEntry } from "./settings-guard";
import { useLiveValue } from "./live-values";
import { tokenState } from "./settings-index";
import { useDrawn } from "./settings-land";
import { cardFormClass, CardActions, LabelledField, Note, SettingsCard } from "./SettingsCard";
import styles from "./SettingsCard.module.css";

/** How long a new token lasts, in the words the admin's choice uses; Never says nothing. */
const LIFETIME_WORDS: Readonly<Record<string, string>> = { "30d": "30 days", "90d": "90 days", "1y": "1 year" };

/** The person's API / MCP tokens: name one and create it, its secret shown
 * once with Copy token and Done, the list with Revoke behind its
 * confirmation. A typed name or a creation on its way holds the page, so
 * leaving asks first naming the card, and once the new secret is on
 * screen, its own words take over: it will not be shown again. Each token
 * says when it expires, and Expired once it has; beside Create, one line
 * says how long a new token lasts, from the runtime read's rule. While
 * the instance's rule leaves token creation to admins, a member's name
 * and Create are disabled with that one sentence instead, and the tokens
 * they made earlier stay listed and revocable. */
export function TokensCard({ admin }: { admin: boolean }) {
  const ids = useId();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null), [attempt, setAttempt] = useState(0);
  const [name, setName] = useState(""), [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false), [busy, setBusy] = useState(false), [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null), [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [lifetime, setLifetime] = useState<string | null>(null), [createRule, setCreateRule] = useState<unknown>(null);
  const refusal = ruleRefusal("tokens.create", createRule, admin);
  // The secret's entry first: when the secret arrives and the name clears in the same render, the page stays held throughout.
  useGuardEntry("tokens-secret", secret !== null, "API / MCP tokens", "The new token will not be shown again.");
  useGuardEntry("tokens-name", secret === null && (name !== "" || creating), "API / MCP tokens");
  // The name being typed is found by the search; the secret never reports.
  useLiveValue("set-token-name", name);
  useDrawn(tokens !== null);
  useEffect(() => {
    let cancelled = false;
    accountRequest<{ tokens: ApiToken[] }>("/api/account/tokens").then(body => {
      if (!cancelled) { setTokens(body.tokens); setError(null); }
    }).catch(error => { if (!cancelled) setError(failureMessage(error)); });
    return () => { cancelled = true; };
  }, [attempt]);
  useEffect(() => {
    let cancelled = false;
    accountRequest<{ rules?: Record<string, unknown> }>("/api/config").then(config => {
      const expiry = config.rules?.["tokens.expiry"];
      if (!cancelled) { setLifetime(typeof expiry === "string" ? LIFETIME_WORDS[expiry] ?? null : null); setCreateRule(config.rules?.["tokens.create"] ?? null); }
    }).catch(() => { /* without the rules the line says nothing and Create stays; each token still says its own expiry */ });
    return () => { cancelled = true; };
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (refusal) return;
    setBusy(true); setCreating(true); setError(null);
    try {
      const created = await accountRequest<ApiToken & { secret: string }>("/api/account/tokens", "POST", { name });
      const { secret: disclosed, ...token } = created;
      setTokens(current => [...(current ?? []), token]); setSecret(disclosed); setCopied(false); setName("");
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); setCreating(false); }
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
  return <SettingsCard id="tokens" title="API / MCP tokens" headingId="tokens-heading">
    <Note>Tokens use your current access, including shared projects.</Note>
    {error && !revoking && <ErrorNote message={error} onRetry={tokens === null ? () => setAttempt(value => value + 1) : undefined}
      onDismiss={tokens === null ? undefined : () => setError(null)} />}
    {secret ? <div className={cardFormClass}>
      <LabelledField label="New token" inputId={`${ids}-secret`}>
        <TextInput id={`${ids}-secret`} readOnly value={secret} onFocus={event => event.target.select()} autoComplete="off" />
      </LabelledField>
      <Note>Copy this token now. It will not be shown again.</Note>
      <CardActions><Button onClick={() => void copy()}>{copied ? "Copied" : "Copy token"}</Button>
        <Button onClick={() => { setSecret(null); setCopied(false); }}>Done</Button></CardActions>
    </div> : <form className={cardFormClass} onSubmit={create}>
      <LabelledField id="set-token-name" label="Token name" inputId={`${ids}-name`}>
        <TextInput id={`${ids}-name`} value={name} onChange={event => setName(event.target.value)} required disabled={busy || tokens === null || !!refusal} />
      </LabelledField>
      <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || tokens === null || !!refusal}>Create token</Button>
      {refusal ? <Note>{refusal}</Note> : lifetime && <Note>{`New tokens expire after ${lifetime}.`}</Note>}
    </form>}
    {tokens === null && !error && <p role="status" className={styles.note}>Loading tokens…</p>}
    {tokens?.length === 0 && <Note>No tokens yet.</Note>}
    {!!tokens?.length && <ul className={styles.list}>{tokens.map(token => <li key={token.id} id={`token-${token.id}`} className={styles.listRow}>
      <div className={styles.listMain}><strong>{token.name}</strong>
        <span className={styles.note}>{tokenState(token)}</span></div>
      {!token.revokedAt && <Button disabled={busy} onClick={() => { setError(null); setRevoking(token); }} aria-label={`Revoke ${token.name}`}>Revoke</Button>}
    </li>)}</ul>}
    {revoking && <Dialog label={`Revoke ${revoking.name}`} className={styles.dialog} onClose={() => { if (!busy) { setRevoking(null); setError(null); } }}>
      <h2>Revoke {revoking.name}?</h2><p>Clients using this token will lose access.</p>
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <CardActions><Button variant="danger" busy={busy} onClick={() => void revoke()}>Revoke token</Button>
        <Button disabled={busy} onClick={() => { setRevoking(null); setError(null); }}>Cancel</Button></CardActions>
    </Dialog>}
  </SettingsCard>;
}
