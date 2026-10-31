"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import { accountRequest, failureMessage } from "@/components/settings/api";
import { SegmentChoice } from "@/components/settings/SettingRows";
import { CardActions, cardFormClass, LabelledField } from "@/components/settings/SettingsCard";
import cardStyles from "@/components/settings/SettingsCard.module.css";

export type KeyProvider = "anthropic" | "openai";
export interface KeyFacts { provider: KeyProvider; lastFour: string; savedAt: string }
export interface KeyStatus { key: KeyFacts | null; unreadable: boolean }

export const KEY_ADDRESS = "/api/account/assistant-key";
export const PROVIDER_NAMES: Readonly<Record<KeyProvider, string>> = { anthropic: "Anthropic", openai: "OpenAI" };
const PROVIDER_CHOICES = (Object.keys(PROVIDER_NAMES) as KeyProvider[]).map(value => ({ value, label: PROVIDER_NAMES[value] }));
const PLACEHOLDERS: Readonly<Record<KeyProvider, string>> = { anthropic: "sk-ant-…", openai: "sk-…" };

/**
 * The key form, the same in the pane and on the Settings card: a provider, the
 * key behind its eye, and Save once something is typed. Saving makes no provider
 * call: the first turn is the check. The text lives in this form's state alone,
 * and a successful save clears it before the caller hears of the save.
 */
export function KeyForm({ initialProvider = "anthropic", onSaved, onCancel, onHolding }: {
  initialProvider?: KeyProvider;
  onSaved: (status: KeyStatus) => void | Promise<void>;
  onCancel?: () => void;
  /** Whether what is typed, or a save on its way, holds the page. */
  onHolding?: (holding: boolean) => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState<KeyProvider>(initialProvider);
  const [key, setKey] = useState(""), [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const typed = key.trim() !== "";
  useEffect(() => { onHolding?.(typed || busy); }, [onHolding, typed, busy]);
  useEffect(() => () => onHolding?.(false), [onHolding]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!typed || busy) return;
    setBusy(true); setError(null);
    try {
      const status = await accountRequest<KeyStatus>(KEY_ADDRESS, "PUT", { provider, key });
      setKey(""); setShown(false);
      await onSaved(status);
    } catch (failure) { setError(failureMessage(failure)); }
    finally { setBusy(false); }
  }
  return <form className={cardFormClass} onSubmit={save}>
    <LabelledField label="Provider" inputId={`${id}-provider`}>
      <SegmentChoice label="Provider" value={provider} choices={PROVIDER_CHOICES} onChange={setProvider} />
    </LabelledField>
    <LabelledField label="API key" inputId={`${id}-key`} error={error} errorId={`${id}-error`}
      rule="Use a key with a spending limit, and revoke it at the provider if it leaks." ruleId={`${id}-rule`}>
      <div className={cardStyles.password}>
        <TextInput id={`${id}-key`} type={shown ? "text" : "password"} autoComplete="new-password" spellCheck={false}
          placeholder={PLACEHOLDERS[provider]} value={key} onChange={event => setKey(event.target.value)} disabled={busy}
          aria-invalid={error ? true : undefined} aria-describedby={`${error ? `${id}-error ` : ""}${id}-rule`} />
        <IconButton action={shown ? "Hide key" : "Show key"} aria-pressed={shown} disabled={busy}
          icon={shown ? <EyeOffIcon /> : <EyeIcon />} onClick={() => setShown(!shown)} />
      </div>
    </LabelledField>
    {(typed || onCancel) && <CardActions>
      {typed && <Button type="submit" variant="primary" busy={busy}>Save</Button>}
      {onCancel && <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>}
    </CardActions>}
  </form>;
}
