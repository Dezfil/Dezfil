"use client";
import { useId, useState, type FormEvent } from "react";
import { INSTANCE_NAME_EVENT } from "@/components/shell/path-model";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountRequest, failureMessage } from "./api";
import { cardFormClass, CardActions, LabelledField, Note, SavedMark, SettingsCard } from "./SettingsCard";

export function WorkspaceCard({ name, admin }: { name: string | null; admin: boolean }) {
  const ids = useId();
  const [instance, setInstance] = useState(name ?? "");
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setSaved(false);
    try {
      const body = await accountRequest<{ instanceName: string | null }>("/api/settings", "PATCH", { instanceName: instance });
      setInstance(body.instanceName ?? ""); setSaved(true);
      window.dispatchEvent(new CustomEvent(INSTANCE_NAME_EVENT, { detail: body.instanceName }));
    } catch (error) { setError(failureMessage(error)); }
    finally { setBusy(false); }
  }
  return <SettingsCard title="Instance" headingId="instance-heading">
    <form className={cardFormClass} onSubmit={submit}>
      <LabelledField label="Instance name" inputId={`${ids}-name`}>
        <TextInput id={`${ids}-name`} value={instance} disabled={!admin || busy} maxLength={80}
          onChange={event => { setInstance(event.target.value); setSaved(false); }} />
      </LabelledField>
      {!admin && <Note>Only admins can change the instance name.</Note>}
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      {admin && <CardActions>
        <Button type="submit" variant="primary" busy={busy}>Save</Button>
        {saved && <SavedMark />}
      </CardActions>}
    </form>
  </SettingsCard>;
}
