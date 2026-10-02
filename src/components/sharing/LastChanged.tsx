"use client";

import { formatRelativeTime } from "../api";
import { firstName, type PersonLabel } from "./people";
import { useSignedInSqlName } from "./signed-in";
import styles from "./LastChanged.module.css";

/** Reached document facts. General update time includes derived bookkeeping. */
export interface LastChange {
  lastChangedAt?: string | null;
  lastChangedBy?: PersonLabel | null;
}

export function LastChanged({ value }: { value: LastChange }) {
  const me = useSignedInSqlName();
  const actor = value.lastChangedBy;
  const time = value.lastChangedAt ? formatRelativeTime(value.lastChangedAt) : "";
  const who = actor ? actor.sqlName === me ? "" : firstName(actor.name) : "Unknown";
  const label = [who, time].filter(Boolean).join(" · ");
  const exact = value.lastChangedAt ? new Date(value.lastChangedAt).toLocaleString() : "";
  const title = actor ? `${actor.name} (${actor.sqlName})${exact ? ` · ${exact}` : ""}`
    : `Changed${exact ? ` ${exact}` : ""} by an account the record does not name`;
  return <span className={styles.fact} data-last-changed data-unknown={!actor || undefined} title={title}>{label}</span>;
}
