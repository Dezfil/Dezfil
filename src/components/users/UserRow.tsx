"use client";
import Link from "next/link";
import { useId, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Status";
import { ChevronIcon } from "@/components/ui/icons";
import { Face } from "@/components/people/Face";
import { SignInHandOver, type HandOver } from "./SignInHandOver";
import styles from "./UsersScreen.module.css";

/** A day in the reader's language, the month in words: Oct 20, 2026. */
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });

export function UserRow({ account, own, open, busy, handOver, onToggle, onAccess, onReset, onDone, onDelete }: {
  account: Account; own: boolean; open: boolean; busy: boolean; handOver: HandOver | null;
  onToggle: () => void; onAccess: (patch: { isAdmin?: boolean; status?: "active" | "deactivated" }) => Promise<boolean>;
  onReset: () => Promise<boolean>; onDone: () => void; onDelete: () => void;
}) {
  const id = useId(), [confirm, setConfirm] = useState<"reset" | "deactivate" | null>(null);
  const status = account.status === "active" ? "Active" : account.status === "invited" ? "Invited" : "Deactivated";
  const resetLabel = account.status === "invited" ? "New sign-in link" : "Reset password";
  async function act() {
    const success = confirm === "reset" ? await onReset() : await onAccess({ status: "deactivated" });
    if (success) setConfirm(null);
  }
  return <div className={styles.row} data-open={open || undefined} data-off={account.status === "deactivated" || undefined}>
    <button className={styles.rowLine} type="button" aria-expanded={open} aria-controls={id} disabled={busy}
      onClick={() => { setConfirm(null); onToggle(); }}>
      <span className={styles.person}><Face person={account} className={styles.avatar}
        letters={account.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase()} />
        <span className={styles.identity}><b>{account.name}{own && <small> · you</small>}</b></span></span>
      <span className={styles.email}>{account.email}</span><span className={styles.role}>{account.isAdmin ? "Admin" : "Member"}</span>
      <StatusDot state={status} tone={account.status === "active" ? "live" : "quiet"} />
      <span className={styles.seen}>{account.lastSignInAt ? day(account.lastSignInAt) : "Never"}</span>
      <span className={styles.chevron}><ChevronIcon /></span>
    </button>
    {open && <div id={id} className={styles.expanded}>
      <p className={styles.facts}><span>Added <b>{day(account.createdAt)}</b></span><span className={styles.sep}>·</span>
        <span>SQL name <span className={styles.sql}>{account.sqlName}</span></span></p>
      {handOver ? <SignInHandOver value={handOver} onDone={onDone} /> : own ? <div className={styles.actions}>
        <Link href="/settings#password" className={styles.passwordLink}>Change password</Link>
      </div> : confirm ? <div className={styles.actions}>
        <p className={styles.note}>{confirm === "reset" ? "The current password and earlier links will stop working. Browser sessions will end; API tokens stay valid." : "Browser sessions will end and API tokens will lose access. Their work stays here."}</p>
        <Button variant={confirm === "reset" ? "primary" : "danger"} busy={busy} onClick={() => void act()}>{confirm === "reset" ? resetLabel : "Deactivate"}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
      </div> : account.status === "deactivated" ? <div className={styles.actions}>
        <Button busy={busy} onClick={() => void onAccess({ status: "active" })}>Reactivate</Button>
        <span className={styles.grow} />
        <span className={styles.dangerZone}><Button variant="danger" disabled={busy} onClick={onDelete}>Delete account</Button></span>
      </div> : <div className={styles.actions}>
        <Button disabled={busy} onClick={() => setConfirm("reset")}>{resetLabel}</Button>
        <Button disabled={busy} onClick={() => void onAccess({ isAdmin: !account.isAdmin })}>{account.isAdmin ? "Remove admin" : "Make admin"}</Button>
        <span className={styles.grow} />
        <span className={styles.dangerZone}>
          <Button variant="danger" disabled={busy} onClick={() => setConfirm("deactivate")}>Deactivate</Button>
          {account.status === "invited" && <Button variant="danger" disabled={busy} onClick={onDelete}>Delete account</Button>}
        </span>
      </div>}
    </div>}
  </div>;
}
