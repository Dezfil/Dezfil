"use client";
import { useEffect, useRef, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { ListHeading } from "@/components/ListHeading";
import { IconSearch } from "@/components/gallery-icons";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { useSearchShortcut } from "@/components/use-search-shortcut";
import { useTransientNotice } from "@/components/use-transient-notice";
import { accountRequest, failureMessage } from "@/components/settings/api";
import gallery from "@/components/gallery.module.css";
import { InviteUserRow } from "./InviteUserRow";
import { UserRow } from "./UserRow";
import type { HandOver } from "./SignInHandOver";
import styles from "./UsersScreen.module.css";

export function UsersScreen() {
  const [data, setData] = useState<{ users: Account[]; own: string } | null>(null), [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [inviting, setInviting] = useState(false), [open, setOpen] = useState<string | null>(null);
  const [handOver, setHandOver] = useState<HandOver | null>(null);
  const search = useRef<HTMLInputElement>(null); useSearchShortcut(search);
  const { notice, show } = useTransientNotice();
  useEffect(() => {
    let cancelled = false;
    Promise.all([accountRequest<{ users: Account[] }>("/api/users"), accountRequest<{ account: Account }>("/api/account")])
      .then(([users, identity]) => { if (!cancelled) { setData({ users: users.users, own: identity.account.id }); setError(null); } })
      .catch(error => { if (!cancelled) setError(failureMessage(error)); });
    return () => { cancelled = true; };
  }, [attempt]);
  function update(account: Account) {
    setData(current => current ? { ...current, users: current.users.some(user => user.id === account.id)
      ? current.users.map(user => user.id === account.id ? account : user) : [...current.users, account] } : null);
  }
  async function change(id: string, patch: { isAdmin?: boolean; status?: "active" | "deactivated" }) {
    setBusy(true); setError(null);
    try {
      const { account } = await accountRequest<{ account: Account }>(`/api/users/${encodeURIComponent(id)}`, "PATCH", patch);
      update(account); show(`${account.name}: ${patch.status === "deactivated" ? "deactivated" : patch.status === "active" ? "reactivated" : account.isAdmin ? "admin access granted" : "admin access removed"}`);
      return true;
    } catch (error) { setError(failureMessage(error)); return false; }
    finally { setBusy(false); }
  }
  async function reset(id: string) {
    setBusy(true); setError(null);
    try {
      const issued = await accountRequest<HandOver>(`/api/users/${encodeURIComponent(id)}/sign-in-link`, "POST");
      update(issued.account); setHandOver(issued); return true;
    } catch (error) { setError(failureMessage(error)); return false; }
    finally { setBusy(false); }
  }
  const shown = data?.users.filter(user => `${user.name} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const active = shown.filter(user => user.status !== "deactivated"), deactivated = shown.filter(user => user.status === "deactivated");
  function row(account: Account) {
    return <UserRow key={account.id} account={account} own={account.id === data?.own} open={open === account.id} busy={busy}
      handOver={handOver?.account.id === account.id ? handOver : null}
      onToggle={() => { setOpen(open === account.id ? null : account.id); setHandOver(null); }}
      onAccess={patch => change(account.id, patch)} onReset={() => reset(account.id)} onDone={() => setHandOver(null)} />;
  }
  return <div className={styles.screen}>
    <ListHeading title="Users" line={null} action={{ label: "Invite", disabled: !data || busy || inviting,
      onClick: () => { setInviting(true); setOpen(null); setHandOver(null); } }} />
    {error && <ErrorNote message={error} onRetry={!data ? () => setAttempt(value => value + 1) : undefined} onDismiss={data ? () => setError(null) : undefined} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={gallery.toolbar}><label className={gallery.search}><IconSearch /><input ref={search} aria-label="Search users"
      placeholder="Search users…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>/</kbd></label></div>
    {!data && !error && <p role="status">Loading users…</p>}
    {data && <div className={`${gallery.listCard} ${styles.ledger}`}>
      <div className={`${gallery.listHead} ${styles.columns}`} aria-hidden><span>Person</span><span>Email</span><span>Role</span><span>Status</span><span>Last sign-in</span><span /></div>
      {inviting && <InviteUserRow onCancel={() => setInviting(false)} onCreated={issued => {
        update(issued.account); setQuery(""); setInviting(false); setOpen(issued.account.id); setHandOver(issued); show(`Account created for ${issued.account.name}`);
      }} onReactivate={async id => { if (await change(id, { status: "active" })) { setInviting(false); setOpen(id); setQuery(""); } }} />}
      {active.map(row)}
      {deactivated.length > 0 && <div className={styles.group}>Deactivated · {deactivated.length}</div>}
      {deactivated.map(row)}
      {shown.length === 0 && <p className={styles.empty}>No one matches this search.</p>}
    </div>}
  </div>;
}
