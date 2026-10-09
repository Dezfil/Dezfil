"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { STORAGE_KINDS, type StorageKind, type StorageRead, type StorageUse } from "@/lib/system/storage-answer";
import { accountRequest, failureMessage } from "./api";
import { useMoment } from "./ServiceChecks";
import { RowError, Rows, SettingRow, ValueText } from "./SettingRows";
import { SavedMark, SettingsCard } from "./SettingsCard";
import { useDrawn } from "./settings-land";
import { amountWords, cachesCleared, filesWords, FREE_ROW, freeWords, shareOf, STORAGE_CARD, STORAGE_ROWS } from "./storage-table";
import cardStyles from "./SettingsCard.module.css";
import dataStyles from "./DataTab.module.css";
import styles from "./SystemTab.module.css";

/**
 * System's Storage: what the data folder holds, read when System opens.
 * The head gives the total; each kind its size, its share of the total
 * and how many files; the service caches Clear all, through the caches'
 * own operation; Leftover files only its note, with nothing to press;
 * then the free space on the folder's volume. No name or path is drawn:
 * the read holds none.
 */

const STORAGE = "/api/instance/storage";
const CLEAR_CACHES = "/api/instance/caches";

export function StorageCard() {
  const [storage, setStorage] = useState<StorageRead | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    accountRequest<StorageRead>(STORAGE).then(body => {
      if (!cancelled) { setStorage(body); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  useDrawn(storage !== null || error !== null);
  return <SettingsCard id={STORAGE_CARD.id} title={STORAGE_CARD.title} count={storage ? amountWords(storage.total) : undefined} headingId="system-storage-heading">
    {error && <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />}
    {!storage && !error && <p role="status" className={cardStyles.loading}>Loading…</p>}
    {storage && <Rows>
      {STORAGE_KINDS.map(kind => kind === "service_caches"
        ? <CachesRow key={kind} use={storage.kinds[kind]} total={storage.total} onCleared={() => setStorage(current => current && cachesCleared(current))} />
        : <KindRow key={kind} kind={kind} use={storage.kinds[kind]} total={storage.total} />)}
      <SettingRow id={FREE_ROW.id} label={FREE_ROW.label}><ValueText muted={!storage.disk}>{freeWords(storage.disk)}</ValueText></SettingRow>
    </Rows>}
  </SettingsCard>;
}

/** A kind's size, its share of the total as a bar, and its files. */
function Use({ use, total }: { use: StorageUse; total: StorageUse }) {
  const files = filesWords(use);
  return <>
    <span className={styles.amount}><ValueText>{amountWords(use)}</ValueText></span>
    <span className={dataStyles.bar} aria-hidden="true"><i style={{ width: `${shareOf(use, total)}%` }} /></span>
    {files && <span className={styles.quiet}>{files}</span>}
  </>;
}

function KindRow({ kind, use, total }: { kind: StorageKind; use: StorageUse; total: StorageUse }) {
  const row = STORAGE_ROWS[kind];
  return <SettingRow id={row.id} label={row.label} meta={row.meta}><Use use={use} total={total} /></SettingRow>;
}

/** The service caches, with Clear all: it empties the three at once and
 * says Cleared. Held back only while they are known to be empty. */
function CachesRow({ use, total, onCleared }: { use: StorageUse; total: StorageUse; onCleared: () => void }) {
  const row = STORAGE_ROWS.service_caches;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [cleared, showCleared, hideCleared] = useMoment();
  const empty = use.finished && use.files === 0 && use.bytes === 0;
  async function clear() {
    setBusy(true); setError(null); hideCleared();
    try {
      await accountRequest(CLEAR_CACHES, "DELETE");
      onCleared();
      showCleared();
    } catch (failure) { setError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  return <SettingRow id={row.id} label={row.label}>
    <Use use={use} total={total} />
    <Button busy={busy} disabled={empty} onClick={() => void clear()}>Clear all</Button>
    {cleared && <SavedMark text="Cleared" />}
    {error && <RowError id={`${row.id}-error`}>{error}</RowError>}
  </SettingRow>;
}
