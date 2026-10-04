"use client";
import { useId } from "react";
import type { PendingDeletion } from "@/lib/auth/account-deletion-status";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/Status";
import { ChevronIcon } from "../ui/icons";
import styles from "./UsersScreen.module.css";

export function DeletingUserRow({ value, open, busy, onToggle, onFinish }: {
  value: PendingDeletion; open: boolean; busy: boolean; onToggle: () => void; onFinish: () => void;
}) {
  const id = useId(), { account, state } = value;
  return <div className={styles.row} data-open={open || undefined} data-off data-deletion={state}>
    <button className={styles.rowLine} type="button" aria-expanded={open} aria-controls={id} disabled={busy} onClick={onToggle}>
      <span className={styles.person}><span className={styles.identity}><b>{account.name}</b></span></span>
      <span className={styles.email}>{account.email}</span><span className={styles.role}>{account.isAdmin ? "Admin" : "Member"}</span>
      <StatusDot state={state === "pending" ? "Deleting" : "Deletion unfinished"} tone="quiet" />
      <span /><span className={styles.chevron}><ChevronIcon /></span>
    </button>
    {open && <div id={id} className={styles.expanded}><div className={styles.actions}>
      <Button busy={busy} onClick={onFinish}>Finish deleting</Button>
    </div></div>}
  </div>;
}
