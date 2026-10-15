"use client";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PARTS } from "@/lib/system/part-test-answer";
import type { PartStates } from "@/lib/system/part-states";
import { accountRequest, failureMessage } from "./api";
import { INSTANCE_SETTINGS, useInstanceRead, type InstanceRead } from "./instance-read";
import { Rows, SettingRow, ValueText } from "./SettingRows";
import { Note, SettingsCard } from "./SettingsCard";
import { useDrawn } from "./settings-land";
import { PartRow, State } from "./StatusRows";
import { StorageCard } from "./StorageCard";
import type { Health } from "./status-table";
import { providerName, runningFor, serverSettingsRows, type AssistantStatus, type SettingSource, type ShownValue } from "./system-table";
import cardStyles from "./SettingsCard.module.css";
import styles from "./SystemTab.module.css";

/** System: the version and each part's state with its Test, what the data
 * folder holds by kind, the assistant's status, and every setting a server
 * variable decides with the value in effect and where it came from.
 * Nothing here changes a setting. */
export function SystemTab() {
  const { read, error, retry } = useInstanceRead();
  const health = useHealth();
  useDrawn(!!read);
  useDrawn(health !== "checking");
  if (error) return <ErrorNote message={error} onRetry={retry} />;
  if (!read) return <p role="status" className={cardStyles.loading}>Loading settings…</p>;
  return <>
    <StatusCard read={read} health={health} />
    <StorageCard />
    <AssistantCard />
    <ServerSettingsCard read={read} />
  </>;
}

/** The health read the rail's dot uses: ready when the data folder is usable. */
function useHealth(): Health {
  const [health, setHealth] = useState<Health>("checking");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then(response => { if (!cancelled) setHealth(response.ok ? "ready" : "unready"); })
      .catch(() => { if (!cancelled) setHealth("unready"); });
    return () => { cancelled = true; };
  }, []);
  return health;
}

/** The parts as last read: the tab's read, then each read again after a
 * Test answers. A read that fails keeps what was shown. */
function useParts(read: InstanceRead): [PartStates, () => void] {
  const [fresh, setFresh] = useState<PartStates | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const again = () => {
    accountRequest<InstanceRead>(INSTANCE_SETTINGS).then(body => { if (mounted.current && body.parts) setFresh(body.parts); }).catch(() => {});
  };
  return [fresh ?? read.parts, again];
}

function StatusCard({ read, health }: { read: InstanceRead; health: Health }) {
  const [parts, readAgain] = useParts(read);
  return <SettingsCard id="system-status" title="Status" headingId="system-status-heading">
    <Rows>
      <SettingRow id="sys-version" label="Version" after={runningFor(read.startedAt)}><ValueText>{read.version}</ValueText></SettingRow>
      {PARTS.map(part => <PartRow key={part} part={part} read={{ settings: read.settings, parts }} health={health} onAnswered={readAgain} />)}
    </Rows>
  </SettingsCard>;
}

/** The assistant as its status read reports it: on with its provider, or
 * off with the reason. Nothing here changes it. */
function AssistantCard() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    accountRequest<AssistantStatus>("/api/assistant").then(body => {
      if (!cancelled) { setStatus(body); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  useDrawn(!!status);
  return <SettingsCard id="system-assistant" title="Assistant" headingId="system-assistant-heading">
    {error && <ErrorNote message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} />}
    {!status && !error && <p role="status" className={cardStyles.loading}>Loading…</p>}
    {status && <Rows>
      <SettingRow id="sys-assistant-status" label="Status">
        <State state={status.enabled ? "on" : "off"}>{status.enabled ? "On" : "Off"}</State>
        {!status.enabled && <span className={styles.quiet}>{status.reason}</span>}
      </SettingRow>
      <SettingRow id="sys-assistant-provider" label="Provider">
        {status.enabled ? <span className={styles.chip}>{providerName(status.provider)}</span> : <ValueText muted>None</ValueText>}
      </SettingRow>
    </Rows>}
  </SettingsCard>;
}

function Shown({ value }: { value: ShownValue }) {
  if (value.mono) return <><ValueText mono>{value.text}</ValueText>{value.after}</>;
  return <ValueText muted={value.muted}>{value.text}</ValueText>;
}

function Source({ source }: { source: SettingSource }) {
  if (source.kind === "stored" && source.href) return <Link href={source.href} scroll={false} className={styles.link}>{source.where}</Link>;
  return <ValueText muted>{source.kind === "environment" ? "Environment" : source.kind === "default" ? "Default" : "Stored"}</ValueText>;
}

/** A variable's name with a place to break after each underscore, taken
 * only where the table is too narrow for whole names; a copy of it reads
 * the name unchanged. */
function VariableName({ name }: { name: string }) {
  const parts = name.split("_");
  return <>{parts.map((part, i) => <Fragment key={i}>{part}{i < parts.length - 1 && <>_<wbr /></>}</Fragment>)}</>;
}

function ServerSettingsCard({ read }: { read: InstanceRead }) {
  return <SettingsCard id="system-settings" title="Server settings" headingId="system-settings-heading">
    <Note>Values from the environment change when the server restarts.</Note>
    <div className={styles.tableBox}>
      <table className={styles.table}>
        <thead><tr><th scope="col">Setting</th><th scope="col">Variable</th><th scope="col">Value</th><th scope="col">Source</th></tr></thead>
        <tbody>{serverSettingsRows(read).map(row => <tr key={row.key} id={row.id}>
          <td className={styles.setting}>{row.label}</td>
          <td className={styles.variable}><ValueText mono><VariableName name={row.variable} /></ValueText></td>
          <td><Shown value={row.value} /></td>
          <td className={styles.source}><Source source={row.source} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  </SettingsCard>;
}
