"use client";
import { useId, useRef } from "react";
import { INSTANCE_NAME_EVENT } from "@/components/shell/path-model";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { keptValues, writeInstanceSettings } from "./instance-read";
import { SaveUnit, type Value } from "./save-unit";
import { unitControlFor, type ReadSetting } from "./server-set";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import { cardFormClass, LabelledField, Note, SaveLine, SettingsCard } from "./SettingsCard";

/** The Instance card: this instance's name, beside the wordmark and in
 * browser titles. Admins edit it; members see it disabled. It has no
 * Reset: an instance's own name has nothing to return to. */
export function WorkspaceCard(props: { admin: true; setting: ReadSetting } | { admin: false; name: string | null }) {
  return props.admin ? <AdminInstance setting={props.setting} /> : <MemberInstance name={props.name} />;
}

function instanceUnit(setting: ReadSetting): SaveUnit {
  return new SaveUnit({
    title: "Instance", controls: [unitControlFor(setting, { reset: false })], kept: { instanceName: setting.value as Value },
    write: async patch => {
      const kept = keptValues(await writeInstanceSettings(patch), ["instanceName"]);
      // The header's chip and the browser title follow what was kept.
      window.dispatchEvent(new CustomEvent(INSTANCE_NAME_EVENT, { detail: kept.instanceName ?? null }));
      return kept;
    },
  });
}

function AdminInstance({ setting }: { setting: ReadSetting }) {
  const ids = useId();
  const root = useRef<HTMLElement>(null);
  const [unit, card] = useSaveUnit("card-instance", () => instanceUnit(setting));
  useUnitFocus(root, card.focus);
  const error = card.errors.instanceName;
  return <SettingsCard ref={root} id="card-instance" title="Instance" headingId="instance-heading">
    <form className={cardFormClass} noValidate onSubmit={event => { event.preventDefault(); unit.save(); }}>
      <LabelledField id="set-instance-name" label="Instance name" inputId={`${ids}-name`} saved={card.saved.includes("instanceName")}
        error={error} errorId={`${ids}-name-error`}>
        <TextInput id={`${ids}-name`} data-unit-key="instanceName" value={String(card.values.instanceName ?? "")} maxLength={80}
          disabled={card.busy} aria-invalid={error ? true : undefined} aria-describedby={error ? `${ids}-name-error` : undefined}
          onChange={event => unit.edit("instanceName", event.target.value)} />
      </LabelledField>
      {card.note && <ErrorNote message={card.note.message} onRetry={card.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
      {card.saveLine && <SaveLine busy={card.busy} onCancel={() => unit.cancel()} />}
    </form>
  </SettingsCard>;
}

function MemberInstance({ name }: { name: string | null }) {
  const ids = useId();
  return <SettingsCard id="card-instance" title="Instance" headingId="instance-heading">
    <LabelledField id="set-instance-name" label="Instance name" inputId={`${ids}-name`}>
      <TextInput id={`${ids}-name`} value={name ?? ""} disabled readOnly />
    </LabelledField>
    <Note>Only admins can change the instance name.</Note>
  </SettingsCard>;
}
