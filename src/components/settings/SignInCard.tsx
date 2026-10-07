"use client";
import { useId, useRef } from "react";
import { Select, Textarea, TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { forgotLine, LANDING_PAGES } from "@/components/auth/entry-settings";
import { keptValues, writeInstanceSettings } from "./instance-read";
import { SaveUnit, type Value } from "./save-unit";
import { unitControlFor, type ReadSetting } from "./server-set";
import { useSaveUnit, useUnitFocus } from "./use-save-unit";
import { useLiveValue } from "./live-values";
import { cardFormClass, LabelledField, Note, ResetSlot, SaveLine, SettingsCard } from "./SettingsCard";

const KEYS = ["signInMessage", "lostPasswordContact", "landingPage"] as const;
type SignInValues = Readonly<Record<(typeof KEYS)[number], Value>>;

/** The Sign-in card: the message on the sign-in page, who to ask about a
 * lost password (its line previewed as it is typed), and the page people
 * land on after signing in. The message and the contact wait for Save;
 * the landing page is kept as it is chosen. Admins edit and may reset it
 * to no message, the built-in line and Home; members see it disabled. */
export function SignInCard(props: { admin: true; settings: Readonly<Record<string, ReadSetting>> } | { admin: false; values: SignInValues }) {
  return props.admin ? <AdminSignIn settings={props.settings} /> : <MemberSignIn values={props.values} />;
}

function signInUnit(settings: Readonly<Record<string, ReadSetting>>): SaveUnit {
  return new SaveUnit({
    title: "Sign-in",
    controls: KEYS.map(key => unitControlFor(settings[key])),
    kept: Object.fromEntries(KEYS.map(key => [key, settings[key].value as Value])),
    write: async patch => keptValues(await writeInstanceSettings(patch), KEYS),
  });
}

function AdminSignIn({ settings }: { settings: Readonly<Record<string, ReadSetting>> }) {
  const root = useRef<HTMLElement>(null);
  const [unit, card] = useSaveUnit("card-sign-in", () => signInUnit(settings));
  useUnitFocus(root, card.focus);
  useLiveValue("set-sign-in-message", String(card.values.signInMessage ?? ""));
  useLiveValue("set-lost-password-contact", String(card.values.lostPasswordContact ?? ""));
  return <SettingsCard ref={root} id="card-sign-in" title="Sign-in" headingId="sign-in-heading" head={<ResetSlot unit={unit} card={card} />}>
    <form className={cardFormClass} noValidate onSubmit={event => { event.preventDefault(); unit.save(); }}>
      <SignInFields values={card.values as SignInValues} disabled={card.busy} saved={card.saved} errors={card.errors}
        onText={(key, value) => unit.edit(key, value)} onChoose={(key, value) => unit.choose(key, value)} />
      {card.note && <ErrorNote message={card.note.message} onRetry={card.note.retry ? () => unit.retry() : undefined} onDismiss={() => unit.dismiss()} />}
      {card.saveLine && <SaveLine busy={card.busy} onCancel={() => unit.cancel()} />}
    </form>
  </SettingsCard>;
}

function MemberSignIn({ values }: { values: SignInValues }) {
  return <SettingsCard id="card-sign-in" title="Sign-in" headingId="sign-in-heading">
    <SignInFields values={values} disabled />
    <Note>Only admins can change the sign-in settings.</Note>
  </SettingsCard>;
}

function SignInFields({ values, disabled, saved = [], errors = {}, onText, onChoose }: {
  values: SignInValues;
  disabled: boolean;
  saved?: readonly string[];
  errors?: Readonly<Record<string, string>>;
  onText?: (key: string, value: string) => void;
  onChoose?: (key: string, value: string) => void;
}) {
  const ids = useId();
  const id = (key: string) => `${ids}-${key}`;
  const invalid = (key: string) => errors[key] ? { "aria-invalid": true, "aria-describedby": `${id(key)}-error` } : {};
  const text = (key: string) => String(values[key as keyof SignInValues] ?? "");
  const red = (key: string) => ({ saved: saved.includes(key), error: errors[key], errorId: `${id(key)}-error` });
  return <>
    <LabelledField id="set-sign-in-message" label="Message" inputId={id("message")} {...red("signInMessage")}
      rule="Anyone who opens the sign-in page can read it.">
      <Textarea id={id("message")} data-unit-key="signInMessage" rows={3} maxLength={280} value={text("signInMessage")}
        disabled={disabled} readOnly={!onText} {...invalid("signInMessage")} onChange={onText && (event => onText("signInMessage", event.target.value))} />
    </LabelledField>
    <LabelledField id="set-lost-password-contact" label="Lost password contact" inputId={id("contact")} {...red("lostPasswordContact")}
      rule={`Shown as “${forgotLine(text("lostPasswordContact"))}”`}>
      <TextInput id={id("contact")} data-unit-key="lostPasswordContact" placeholder="an admin" maxLength={120} value={text("lostPasswordContact")}
        disabled={disabled} readOnly={!onText} {...invalid("lostPasswordContact")} onChange={onText && (event => onText("lostPasswordContact", event.target.value))} />
    </LabelledField>
    <LabelledField id="set-landing-page" label="Landing page" inputId={id("landing")} {...red("landingPage")}>
      <Select id={id("landing")} data-unit-key="landingPage" value={text("landingPage") || "home"} disabled={disabled}
        {...invalid("landingPage")} onChange={onChoose && (event => onChoose("landingPage", event.target.value))}>
        {LANDING_PAGES.map(page => <option key={page.value} value={page.value}>{page.label}</option>)}
      </Select>
    </LabelledField>
  </>;
}
