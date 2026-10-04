"use client";

import { isDeletedActor, type AccountActor } from "@/lib/account-actor";
import { ClockIcon } from "../ui/icons";
import { formatRelativeTime } from "../api";
import { firstName } from "./people";
import { useSignedInSqlName } from "./signed-in";
import styles from "./LastChanged.module.css";

/** Reached document facts. General update time includes derived bookkeeping. */
export interface LastChange {
  lastChangedAt?: string | null;
  lastChangedBy?: AccountActor | null;
}

export function LastChanged({ value, head = false }: { value: LastChange; head?: boolean }) {
  const me = useSignedInSqlName();
  const actor = value.lastChangedBy;
  const time = value.lastChangedAt ? formatRelativeTime(value.lastChangedAt) : "";
  const deleted = isDeletedActor(actor);
  const who = deleted ? "Deleted account" : actor ? !head && actor.sqlName === me ? "" : firstName(actor.name) : "Unknown";
  const label = [who, time].filter(Boolean).join(" · ");
  const exact = value.lastChangedAt ? new Date(value.lastChangedAt).toLocaleString() : "";
  const title = deleted ? `Deleted account${exact ? ` · ${exact}` : ""}` : actor ? `${actor.name} (${actor.sqlName})${exact ? ` · ${exact}` : ""}`
    : `Changed${exact ? ` ${exact}` : ""} by an account the record does not name`;
  return <span className={head ? `${styles.fact} ${styles.head}` : styles.fact} data-last-changed data-unknown={!actor || undefined} data-deleted={deleted || undefined} title={title} data-hint={head ? undefined : title} aria-label={`Last changed: ${label}`}>{head && <ClockIcon />}{head ? <span className={styles.headText}>{label}</span> : label}</span>;
}
