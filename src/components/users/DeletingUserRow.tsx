"use client";
import { useId } from "react";
import type { ReadablePendingDeletion } from "@/lib/auth/account-deletion-status";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/Status";
import { ChevronIcon } from "../ui/icons";
import styles from "./UsersScreen.module.css";

/** A pending deletion's status names the reads it still waits on, while
 * there are any: a deletion that stays there is held by a reader, not stuck. */
function pendingStatus(waiting: number): string {
  return waiting > 0 ? `Deleting · waiting on ${waiting} ${waiting === 1 ? "read" : "reads"}` : "Deleting";
}

export function DeletingUserRow({ value, waiting, open, busy, onToggle, onFinish }: {
  value: ReadablePendingDeletion; waiting: number; open: boolean; busy: boolean; onToggle: () => void; onFinish: () => void;
}) {
  const id = useId(), { account, state } = value;
  return <div className={styles.row} data-open={open || undefined} data-off data-deletion={state}>
    <button className={styles.rowLine} type="button" aria-expanded={open} aria-controls={id} disabled={busy} onClick={onToggle}>
      <span className={styles.person}><span className={styles.identity}><b>{account.name}</b></span></span>
      <span className={styles.email}>{account.email}</span><span className={styles.role}>{account.isAdmin ? "Admin" : "Member"}</span>
      <StatusDot state={state === "pending" ? pendingStatus(waiting) : "Deletion unfinished"} tone="quiet" />
      <span /><span className={styles.chevron}><ChevronIcon /></span>
    </button>
    {open && <div id={id} className={styles.expanded}><div className={styles.actions}>
      <Button busy={busy} onClick={onFinish}>Finish deleting</Button>
    </div></div>}
  </div>;
}
