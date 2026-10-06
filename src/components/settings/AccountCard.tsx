"use client";
import { useId, useRef } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { DISPLAY_NAME_EVENT } from "@/components/UserBadge";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { PasswordCard } from "./PasswordCard";
import { PasswordField } from "./PasswordField";
import { settingsWrite } from "./api";
import { SaveUnit, type Value } from "./save-unit";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import { cardFormClass, LabelledField, Note, SaveLine, SettingsCard } from "./SettingsCard";
import styles from "./SettingsCard.module.css";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normal = (email: Value | undefined) => String(email ?? "").trim().toLowerCase();

/** The account as a save unit: every field is typed text, kept on Save. A
 * changed email takes the current password with it; the password is never
 * kept. The server's refusals are written for the whole card. */
function accountUnit(account: Account): SaveUnit {
  const unit: SaveUnit = new SaveUnit({
    title: "Account",
    controls: [{ key: "name", kind: "text" }, { key: "email", kind: "text" }, { key: "currentPassword", kind: "text" }],
    kept: { name: account.name, email: account.email, currentPassword: "" },
    refusalRows: false,
    validate: values => {
      const problems: Record<string, string> = {};
      if (!String(values.name ?? "").trim()) problems.name = "Enter a display name.";
      const email = String(values.email ?? "").trim();
      if (!email) problems.email = "Enter your email address.";
      else if (!EMAIL.test(email)) problems.email = "Enter an email address like name@example.com.";
      else if (normal(email) !== normal(unit.snapshot.kept.email) && !values.currentPassword) {
        problems.currentPassword = "Enter your current password to change your email.";
      }
      return problems;
    },
    write: async patch => {
      const kept = unit.snapshot.kept, values = unit.snapshot.values;
      const changingEmail = normal(values.email) !== normal(kept.email);
      const { account: updated } = await settingsWrite<{ account: Account }>("/api/account", "PATCH", {
        name: String(values.name ?? ""), ...(changingEmail ? { email: String(values.email ?? ""), currentPassword: String(patch.currentPassword ?? values.currentPassword ?? "") } : {}),
      });
      window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: updated.name }));
      return { name: updated.name, email: updated.email, currentPassword: "" };
    },
  });
  return unit;
}

/** The person's own account: display name, the SQL name, email (a changed
 * email asks for the current password), then Change password on its own
 * button. Save and Cancel show only while a field differs from what was
 * saved; no Reset, since an account has no defaults. */
export function AccountCard({ account }: { account: Account }) {
  const ids = useId();
  const form = useRef<HTMLFormElement>(null);
  const [unit, card] = useSaveUnit("account", () => accountUnit(account));
  useUnitFocus(form, card.focus);
  const changingEmail = normal(card.values.email) !== normal(card.kept.email);
  const text = (key: string) => String(card.values[key] ?? "");
  const invalid = (key: string) => card.errors[key] ? { "aria-invalid": true, "aria-describedby": `${ids}-${key}-error` } : {};
  return <SettingsCard id="account" title="Account" headingId="account-heading">
    <form ref={form} className={cardFormClass} noValidate onSubmit={event => { event.preventDefault(); unit.save(); }}>
      <LabelledField id="set-display-name" label="Display name" inputId={`${ids}-name`} saved={card.saved.includes("name")}
        error={card.errors.name} errorId={`${ids}-name-error`}>
        <TextInput id={`${ids}-name`} data-unit-key="name" value={text("name")} maxLength={80} required autoComplete="name"
          disabled={card.busy} {...invalid("name")} onChange={event => unit.edit("name", event.target.value)} />
      </LabelledField>
      <p id="set-sql-name" className={styles.sqlName}><span>SQL name</span><code>{account.sqlName}</code></p>
      <Note>Your SQL name stays the same when you change your name or email.</Note>
      <LabelledField id="set-email" label="Email" inputId={`${ids}-email`} saved={card.saved.includes("email")}
        error={card.errors.email} errorId={`${ids}-email-error`}>
        <TextInput id={`${ids}-email`} data-unit-key="email" type="email" value={text("email")} required autoComplete="email"
          disabled={card.busy} {...invalid("email")} onChange={event => {
            // The current password goes with the change it was asked for.
            if (normal(event.target.value) === normal(card.kept.email) && text("currentPassword")) unit.edit("currentPassword", "");
            unit.edit("email", event.target.value);
          }} />
      </LabelledField>
      {changingEmail && <PasswordField label="Current password to change email" unitKey="currentPassword" value={text("currentPassword")}
        onChange={value => unit.edit("currentPassword", value)} disabled={card.busy} error={card.errors.currentPassword} />}
      {card.note && <ErrorNote message={card.note.message} onRetry={card.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
      {card.saveLine && <SaveLine busy={card.busy} onCancel={() => unit.cancel()} />}
    </form>
    <PasswordCard />
  </SettingsCard>;
}
