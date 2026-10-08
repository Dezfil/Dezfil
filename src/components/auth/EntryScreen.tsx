"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ThemeProvider, ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { TextInput } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import { RhumbChart } from "./RhumbChart";
import styles from "./EntryScreen.module.css";
import { accountChanged } from "./private-state";
import { forgotLine, landingRoute } from "./entry-settings";

type Mode = "setup" | "sign-in" | "redeem";
interface Entry {
  instanceName: string | null; setupRequired: boolean; prefillName?: string;
  /** What an admin set for this screen: a message on the sign-in page, who
   * to ask about a lost password, and where people land once signed in. */
  signInMessage?: string | null; lostPasswordContact?: string | null; landingPage?: string | null;
  /** The fewest characters a password chosen here needs. */
  passwordMin?: number;
}
interface Failure { code?: string; message?: string; retryAt?: string; }
export function EntryScreen({ mode }: { mode: Mode }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [name, setName] = useState(""); const [email, setEmail] = useState("");
  const [password, setPassword] = useState(""); const [secret, setSecret] = useState("");
  const [shown, setShown] = useState(false); const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const setup = mode === "setup", redeem = mode === "redeem";
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/entry", { cache: "no-store", signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "This instance is unavailable. Try again.");
      const info = value as Entry;
      if (mode === "setup" && !info.setupRequired) { window.location.replace("/sign-in"); return; }
      if (mode === "sign-in" && info.setupRequired) { window.location.replace("/setup"); return; }
      if (mode === "redeem") setSecret(new URLSearchParams(window.location.hash.slice(1)).get("secret") ?? "");
      setEntry(info); if (mode === "setup") setName(info.prefillName ?? "");
    }).catch(error => { if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : "This instance is unavailable. Try again."); });
    return () => controller.abort();
  }, [mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFailure(null);
    try {
      const endpoint = setup ? "/api/auth/setup" : redeem ? "/api/auth/redeem" : "/api/auth/sign-in";
      const body = setup ? { name, email, password } : redeem ? { secret, password } : { email, password };
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      const value = await response.json();
      if (!response.ok) {
        const error = value.error as Failure;
        if (error?.code === "setup_complete") { window.location.replace("/sign-in"); return; }
        if (error?.code === "rate_limited" && error.retryAt) throw new Error(`Too many sign-in attempts. Try again at ${new Date(error.retryAt).toLocaleTimeString()}.`);
        throw new Error(error?.message ?? "This request could not be completed. Try again.");
      }
      accountChanged();
      window.location.replace(new URL(landingRoute(entry?.landingPage), window.location.origin).href);
    } catch (error) { setFailure(error instanceof Error ? error.message : "This instance could not be reached. Try again."); }
    finally { setBusy(false); }
  }
  const missingLink = redeem && entry !== null && !secret;
  const rule = mode !== "sign-in" && typeof entry?.passwordMin === "number" ? `At least ${entry.passwordMin} characters.` : null;
  const instance = entry?.instanceName ?? (setup ? "A new instance" : null);
  const message = mode === "sign-in" ? entry?.signInMessage?.trim() : null;
  return <ThemeProvider><div className={styles.stage}>
    <aside className={styles.brandPane} aria-label="Dezfil">
      <RhumbChart /><div className={styles.shade} />
      <span className={styles.wordmark}>Dezfil</span>
      <div className={styles.foot}>{instance && <span className={styles.instance}>{instance}</span>}
        <span className={styles.subtitle}>{setup ? "Maps, data and SQL, one container." : "Maps, data and SQL on this instance."}</span>
      </div>
      <span className={styles.coordinate} aria-hidden="true">32°23′N · 48°24′E</span>
    </aside>
    <div className={styles.theme}><ThemeToggle /></div>
    <main className={styles.formPane}><div className={styles.column}>
      <div className={styles.heading}><h1>{setup ? "Create the first account" : redeem ? "Choose your password" : "Sign in"}</h1>
        {setup && <p className={styles.help}>It becomes this instance&apos;s admin.</p>}
        {message && <p className={`${styles.help} ${styles.message}`}>{message}</p>}
      </div>
      {(failure || missingLink) && <ErrorNote message={failure ?? "This sign-in link is unavailable. Ask an admin for a new one."} />}
      <form className={styles.form} onSubmit={submit} noValidate>
        {setup && <label className={styles.field}><span>Name</span><TextInput tier="chrome" autoComplete="name" value={name} onChange={event => setName(event.target.value)} required disabled={busy || !entry} /></label>}
        {!redeem && <label className={styles.field}><span>Email</span><TextInput tier="chrome" type="email" autoComplete="email" placeholder="you@example.org" value={email} onChange={event => setEmail(event.target.value)} required disabled={busy || !entry} /></label>}
        <div className={styles.field}><label htmlFor="entry-password">Password</label>
          <div className={styles.password}><TextInput tier="chrome" id="entry-password" type={shown ? "text" : "password"} autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            value={password} onChange={event => setPassword(event.target.value)} required disabled={busy || !entry || missingLink}
            aria-describedby={rule ? "password-rule" : undefined} />
            <IconButton action={shown ? "Hide password" : "Show password"} icon={shown ? <EyeOffIcon /> : <EyeIcon />} aria-pressed={shown} className={styles.eye} onClick={() => setShown(value => !value)} />
          </div>
          {rule && <p id="password-rule" className={styles.help}>{rule}</p>}
        </div>
        <Button type="submit" variant="primary" size="chrome" busy={busy} disabled={!entry || missingLink} className={styles.submit}>{setup ? "Create account" : redeem ? "Set password" : "Sign in"}</Button>
        {mode === "sign-in" && (entry || failure) && <p className={styles.help}>{forgotLine(entry?.lostPasswordContact)}</p>}
      </form>
    </div></main>
  </div></ThemeProvider>;
}
