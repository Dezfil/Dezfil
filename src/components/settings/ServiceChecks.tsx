"use client";
import { useEffect, useRef, useState } from "react";
import type { ProviderCache } from "@/lib/provider-caches";
import type { ServiceTestAnswer, TestedService } from "@/lib/settings/service-test-answer";
import { Button } from "@/components/ui/Button";
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { accountRequest, failureMessage } from "./api";
import { cacheShare, cacheWords, releaseListWords, testAnswerWords, type CacheFacts, type CacheRow, type ReleaseListFacts, type ReleasesRow } from "./data-table";
import { SAVED_HOLD_MS } from "./save-unit";
import { RowError, SettingRow, ValueText } from "./SettingRows";
import { SavedMark } from "./SettingsCard";
import styles from "./DataTab.module.css";

/**
 * What a service card asks of its service and holds for it: the Test,
 * which reaches the service once at the address in effect and answers in
 * its line; a cache's use with Clear; and Overture's release list with
 * Check now, which is Overture's Test. A Test changes no setting; Check
 * now keeps the list it finds, as the Overture pane would.
 */

/** A mark that shows for a moment, then goes. */
function useMoment(): [boolean, () => void, () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    setShown(true);
    timer.current = setTimeout(() => { timer.current = null; setShown(false); }, SAVED_HOLD_MS);
  };
  const hide = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setShown(false); };
  return [shown, show, hide];
}

/** The Test and its answer line. A second press while it runs sends nothing. */
export function ServiceTest({ service, label = "Test", onPassed }: {
  service: TestedService;
  label?: string;
  /** Told of a pass, with its answer. */
  onPassed?: (answer: ServiceTestAnswer) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ readonly passed: boolean; readonly text: string } | null>(null);
  const running = useRef(false);
  async function run() {
    if (running.current) return;
    running.current = true;
    setBusy(true); setShown(null);
    try {
      const answer = await accountRequest<ServiceTestAnswer>(`/api/instance/services/${service}/test`, "POST");
      setShown(testAnswerWords(answer));
      if (answer.result === "passed") onPassed?.(answer);
    } catch (failure) { setShown({ passed: false, text: failureMessage(failure) }); }
    finally { running.current = false; setBusy(false); }
  }
  return <span className={styles.test}>
    <Button busy={busy} onClick={() => void run()}>{label}</Button>
    {shown && <span role="status" className={styles.answer} data-answer={shown.passed ? "passed" : "failed"}>
      {shown.passed ? <CheckIcon /> : <XIcon />}{shown.text}
    </span>}
  </span>;
}

/** A cache's use against its budget and how many answers it holds, or
 * Empty, with Clear: it empties the cache at once and says Cleared. */
export function CacheRowView({ row, facts, onCleared }: { row: CacheRow; facts: CacheFacts | undefined; onCleared: (cache: ProviderCache) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [cleared, showCleared, hideCleared] = useMoment();
  const empty = !facts || (facts.answers === 0 && facts.bytes === 0);
  async function clear() {
    setBusy(true); setError(null); hideCleared();
    try {
      await accountRequest(`/api/instance/caches?service=${row.cache}`, "DELETE");
      onCleared(row.cache);
      showCleared();
    } catch (failure) { setError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  return <SettingRow id={row.id} label={row.label}>
    <span className={styles.bar} aria-hidden="true"><i style={{ width: `${cacheShare(facts)}%` }} /></span>
    <ValueText>{cacheWords(row.cache, facts)}</ValueText>
    <Button busy={busy} disabled={empty} onClick={() => void clear()}>Clear</Button>
    {cleared && <SavedMark text="Cleared" />}
    {error && <RowError id={`${row.id}-error`}>{error}</RowError>}
  </SettingRow>;
}

/** Overture's release list: how many releases the pane offers, the newest
 * and when the list was taken, with Check now. */
export function ReleasesRowView({ row, facts, onListed }: {
  row: ReleasesRow;
  facts: ReleaseListFacts | undefined;
  onListed: (releases: number, newest: string) => void;
}) {
  return <SettingRow id={row.id} label={row.label}>
    <ValueText>{releaseListWords(facts)}</ValueText>
    <ServiceTest service="overture" label="Check now" onPassed={answer => {
      if (answer.result === "passed" && "releases" in answer) onListed(answer.releases, answer.newest);
    }} />
  </SettingRow>;
}
