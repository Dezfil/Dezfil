"use client";
import { useEffect, useRef, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import type { PendingDeletion, ReadablePendingDeletion } from "@/lib/auth/account-deletion-status";
import { ListHeading } from "@/components/ListHeading";
import { IconSearch } from "@/components/gallery-icons";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { Button } from "@/components/ui/Button";
import { useSearchShortcut } from "@/components/use-search-shortcut";
import { useTransientNotice } from "@/components/use-transient-notice";
import { readExternalMode } from "@/components/auth/external-mode";
import { accountRequest, failureMessage } from "@/components/settings/api";
import gallery from "@/components/gallery.module.css";
import { InviteUserRow } from "./InviteUserRow";
import { UserRow } from "./UserRow";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { DeletingUserRow } from "./DeletingUserRow";
import { finishDeletion, type DeletionStatus } from "./deletion-client";
import { useDeletionWatch } from "./use-deletion-watch";
import type { HandOver } from "./SignInHandOver";
import styles from "./UsersScreen.module.css";

export function UsersScreen() {
  const [data, setData] = useState<{ users: Account[]; deletions: PendingDeletion[]; own: string; external: boolean } | null>(null), [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""), [inviting, setInviting] = useState(false), [open, setOpen] = useState<string | null>(null);
  const [handOver, setHandOver] = useState<HandOver | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  // Reads a pending deletion still waits on, as its last status said.
  const [waiting, setWaiting] = useState<ReadonlyMap<string, number>>(() => new Map());
  const focusSearch = useRef(false), finishing = useRef(false);
  const search = useRef<HTMLInputElement>(null); useSearchShortcut(search);
  const { notice, show } = useTransientNotice();
  useEffect(() => {
    let cancelled = false;
    Promise.all([accountRequest<{ users: Account[]; deletions: PendingDeletion[] }>("/api/users"), accountRequest<{ account: Account }>("/api/account"), readExternalMode()])
      .then(([users, identity, external]) => { if (!cancelled) setData({ users: users.users, deletions: users.deletions, own: identity.account.id, external }); })
      .catch(error => { if (!cancelled) setError(failureMessage(error)); });
    return () => { cancelled = true; };
  }, [attempt]);
  useEffect(() => {
    // Dialog cleanup has released inertness and its opener may now be gone.
    if (focusSearch.current && !deleting) { focusSearch.current = false; search.current?.focus(); }
  });
  function deleted(account: ReadablePendingDeletion["account"], status: DeletionStatus) {
    setData(current => current ? { ...current, users: current.users.filter(user => user.id !== account.id),
      deletions: [...current.deletions.filter(value => value.id !== status.id),
        ...(status.state === "completed" ? [] : [{ id: status.id, state: status.state, account }])] } : null);
    setDeleting(null); setHandOver(null); setOpen(null); focusSearch.current = true;
    if (status.state === "completed") show(`${account.name}: deleted`);
  }
  async function finish(value: ReadablePendingDeletion) {
    if (finishing.current) return;
    finishing.current = true; setBusy(true); setError(null);
    try { deleted(value.account, await finishDeletion(value.id)); }
    catch (cause) { setError(failureMessage(cause)); setAttempt(value => value + 1); }
    finally { finishing.current = false; setBusy(false); }
  }
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
  async function removePicture(id: string) {
    setBusy(true); setError(null);
    try {
      const { account } = await accountRequest<{ account: Account }>(`/api/users/${encodeURIComponent(id)}/picture`, "DELETE");
      update(account); show(`${account.name}: picture removed`);
    } catch (error) { setError(failureMessage(error)); }
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
  const matches = (user: { name: string; email: string }) => `${user.name} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase());
  const pending = data?.deletions.filter((value): value is ReadablePendingDeletion => value.state !== "unreadable") ?? [];
  const unreadable = data?.deletions.filter(value => value.state === "unreadable") ?? [];
  const shown = data?.users.filter(user => !pending.some(value => value.account.id === user.id) && matches(user)) ?? [];
  const shownPending = pending.filter(value => matches(value.account));
  // A deletion that has left the store is read off the list again; one that
  // now needs a retry takes that state.
  useDeletionWatch(pending.filter(value => value.state === "pending").map(value => value.id), (id, status) => {
    setWaiting(current => new Map(current).set(id, status?.admittedReads ?? 0));
    if (!status || status.state === "completed") { setAttempt(value => value + 1); return; }
    const state = status.state;
    setData(current => current ? { ...current, deletions: current.deletions.map(value =>
      value.id === id && value.state !== "unreadable" ? { ...value, state } : value) } : null);
  });
  const active = shown.filter(user => user.status !== "deactivated"), deactivated = shown.filter(user => user.status === "deactivated");
  function row(account: Account) {
    return <UserRow key={account.id} account={account} own={account.id === data?.own} open={open === account.id} busy={busy}
      handOver={handOver?.account.id === account.id ? handOver : null} external={data?.external}
      onToggle={() => { setOpen(open === account.id ? null : account.id); setHandOver(null); }}
      onAccess={patch => change(account.id, patch)} onReset={() => reset(account.id)} onRemovePicture={() => void removePicture(account.id)}
      onDone={() => setHandOver(null)} onDelete={() => setDeleting(account)} />;
  }
  return <div className={styles.screen}>
    <ListHeading title="Users" line={null} action={{ label: "Invite", disabled: !data || busy || inviting,
      onClick: () => { setInviting(true); setOpen(null); setHandOver(null); } }} />
    {error && <ErrorNote message={error} onRetry={!data ? () => { setError(null); setAttempt(value => value + 1); } : undefined} onDismiss={data ? () => setError(null) : undefined} />}
    {pending.filter(value => value.state === "needs-retry").map(value => <ErrorNote key={value.id}
      message={`${value.account.name}’s account could not be deleted completely. It stays closed: nobody can sign in to it or open its work.`}>
      <Button disabled={busy} onClick={() => void finish(value)}>Finish deleting</Button>
    </ErrorNote>)}
    {unreadable.map(value => <p key={value.id} className={styles.notice}>Deletion {value.id} cannot be read.</p>)}
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
      {shownPending.map(value => <DeletingUserRow key={value.id} value={value} waiting={waiting.get(value.id) ?? 0} open={open === value.id} busy={busy}
        onToggle={() => setOpen(open === value.id ? null : value.id)} onFinish={() => void finish(value)} />)}
      {shown.length === 0 && shownPending.length === 0 && <p className={styles.empty}>No one matches this search.</p>}
    </div>}
    {deleting && <DeleteAccountDialog account={deleting} onClose={() => setDeleting(null)} onDone={status => deleted(deleting, status)} />}
  </div>;
}
