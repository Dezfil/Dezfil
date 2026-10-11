"use client";
import { useEffect, useRef, useState } from "react";
import type { TemplateDownloads, TemplateList } from "@/lib/templates/card";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SwitchRow } from "@/components/ui/Switch";
import { accountRequest, failureMessage } from "./api";
import { DATA_LABELS, downloadsRemovalWords, downloadsWords, TEMPLATES_CARD } from "./data-table";
import { keptValues, writeInstanceSettings, type InstanceRead } from "./instance-read";
import { inLabels } from "./limits-table";
import { SaveUnit, type Value } from "./save-unit";
import { ServiceTest, useMoment } from "./ServiceChecks";
import { unitControlFor } from "./server-set";
import { ServiceAddressRow } from "./ServiceAddressRow";
import { RowError, Rows, SettingRow, ValueText } from "./SettingRows";
import { CardActions, ResetSlot, SavedMark, SettingsCard } from "./SettingsCard";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import cardStyles from "./SettingsCard.module.css";
import dataStyles from "./DataTab.module.css";

type Settings = InstanceRead["settings"];
const { catalogue: SWITCH, address: ADDRESS, downloads: DOWNLOADS } = TEMPLATES_CARD;
const LIST = "/api/templates";
const DOWNLOADED = "/api/templates/downloads";

/**
 * Data & services' Templates, for admins: whether the server reads the
 * template catalogue, kept at once, with Reset turning it back on; the
 * catalogue's address as a service address's own form, beside its
 * variable (a folder the variable names is shown with no path); the Test,
 * which reads the catalogue's index and answers how many it lists and the
 * time, offered while the catalogue is in use, since the server reaches
 * it for nothing while it is off; and what the downloaded templates hold,
 * from the template list, with Remove all behind its question. Remove all
 * takes downloads alone: never a shipped template or anyone's copy.
 */
export function TemplatesCard({ read, now, onAnswer }: {
  /** The read the switch starts from. */
  read: InstanceRead;
  /** The latest the server reported: the read, or a write's response. */
  now: InstanceRead;
  onAnswer: (read: InstanceRead) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [unit, snapshot] = useSaveUnit(TEMPLATES_CARD.id, () => switchUnit(read.settings, onAnswer));
  useUnitFocus(root, snapshot.focus);
  const inUse = now.settings[SWITCH.key]?.value !== false;
  const head = <>
    <ResetSlot unit={unit} card={snapshot} />
    {inUse && <span className={dataStyles.headEnd}><ServiceTest service={TEMPLATES_CARD.test} /></span>}
  </>;
  const error = snapshot.errors[SWITCH.key];
  return <SettingsCard ref={root} id={TEMPLATES_CARD.id} title={TEMPLATES_CARD.title} headingId={`${TEMPLATES_CARD.id}-heading`} head={head}>
    <Rows>
      {read.settings[SWITCH.key] && <SettingRow id={SWITCH.id} label={SWITCH.label}>
        <SwitchRow label={SWITCH.on} aria-label={SWITCH.name} data-unit-key={SWITCH.key}
          checked={snapshot.values[SWITCH.key] === true} onChange={event => unit.choose(SWITCH.key, event.target.checked)} />
        {snapshot.saved.includes(SWITCH.key) && <SavedMark />}
        {error && <RowError id={`${SWITCH.id}-error`}>{inLabels(error, DATA_LABELS)}</RowError>}
      </SettingRow>}
      <ServiceAddressRow row={ADDRESS} setting={now.settings[ADDRESS.key]} card={TEMPLATES_CARD.title} onAnswer={onAnswer} />
      <DownloadsRow />
    </Rows>
    {snapshot.note && <ErrorNote message={inLabels(snapshot.note.message, DATA_LABELS)}
      onRetry={snapshot.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
  </SettingsCard>;
}

/** The switch as a save unit over the instance write: kept at once, Saved
 * after the response, Reset to its default (on) then Undo. */
function switchUnit(settings: Settings, onAnswer: (read: InstanceRead) => void): SaveUnit {
  const keys = settings[SWITCH.key] ? [SWITCH.key] : [];
  return new SaveUnit({
    title: TEMPLATES_CARD.title,
    controls: keys.map(key => unitControlFor(settings[key])),
    kept: Object.fromEntries(keys.map(key => [key, settings[key].value as Value])),
    write: async patch => {
      const answer = await writeInstanceSettings(patch);
      onAnswer(answer);
      return keptValues(answer, keys);
    },
  });
}

/** What the downloaded templates hold, from the template list, which sends
 * nothing outside; Remove all, held back while there is nothing to remove,
 * asks first and says Removed. */
function DownloadsRow() {
  const [downloads, setDownloads] = useState<TemplateDownloads | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [removed, showRemoved, hideRemoved] = useMoment();
  useEffect(() => {
    let cancelled = false;
    accountRequest<TemplateList>(LIST).then(list => { if (!cancelled) setDownloads(list.downloads); })
      .catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, []);
  const none = !downloads || downloads.versions === 0;
  return <SettingRow id={DOWNLOADS.id} label={DOWNLOADS.label}>
    {downloads && <ValueText muted={none}>{downloadsWords(downloads)}</ValueText>}
    <Button disabled={none} onClick={() => { hideRemoved(); setAsking(true); }}>Remove all</Button>
    {removed && <SavedMark text="Removed" />}
    {error && <RowError id={`${DOWNLOADS.id}-error`}>{error}</RowError>}
    {asking && downloads && <RemoveDownloads downloads={downloads} onClose={() => setAsking(false)} onRemoved={gone => {
      // A download that landed meanwhile stays: what went is what Remove all answered.
      setDownloads(current => current && { versions: Math.max(0, current.versions - gone.versions), bytes: Math.max(0, current.bytes - gone.bytes) });
      setAsking(false);
      showRemoved();
    }} />}
  </SettingRow>;
}

/** Remove every downloaded template, once asked. */
function RemoveDownloads({ downloads, onRemoved, onClose }: {
  downloads: TemplateDownloads;
  onRemoved: (gone: TemplateDownloads) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true); setError(null);
    try {
      onRemoved(await accountRequest<TemplateDownloads>(DOWNLOADED, "DELETE"));
    } catch (failure) { setError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  const close = () => { if (!busy) onClose(); };
  return <Dialog label="Remove the downloaded templates" className={cardStyles.dialog} onClose={close}>
    <h2>Remove the downloaded templates?</h2>
    <p>{downloadsRemovalWords(downloads)}</p>
    {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
    <CardActions>
      <Button variant="danger" busy={busy} onClick={() => void remove()}>Remove downloads</Button>
      <Button disabled={busy} onClick={close}>Cancel</Button>
    </CardActions>
  </Dialog>;
}
