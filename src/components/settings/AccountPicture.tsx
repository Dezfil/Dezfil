"use client";
import { useRef, useState } from "react";
import type { Account } from "@/lib/metadata/accounts";
import { readApiError } from "@/components/api";
import { serverUnreachable } from "@/components/failure-copy";
import { Face } from "@/components/people/Face";
import { Button } from "@/components/ui/Button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { accountInitials, DISPLAY_NAME_EVENT } from "@/components/UserBadge";
import { failureMessage } from "./api";
import { Note } from "./SettingsCard";
import styles from "./AccountPicture.module.css";

/** The kinds the server keeps, which it recognises by their content. */
const KINDS = "image/jpeg,image/png,image/webp";

/** Sets the picture from a file, or removes it, and answers the account. */
async function pictureWrite(file: File | null): Promise<Account> {
  let response: Response;
  try {
    const body = file ? new FormData() : undefined;
    if (file) body!.append("file", file);
    response = await fetch("/api/account/picture", { method: file ? "PUT" : "DELETE", cache: "no-store", body });
  } catch { throw new Error(serverUnreachable("change your picture")); }
  if (!response.ok) throw new Error(await readApiError(response));
  return ((await response.json()) as { account: Account }).account;
}

/**
 * The person's own picture on the Account card: their face as the side
 * menu draws it, larger, with Change and Remove. A chosen file is kept at
 * once, as a choice is, and apart from the card's typed text, so a pending
 * name, email or password edit is neither saved nor discarded by it, and
 * Cancel leaves the picture. Only the latest request's answer is drawn, so
 * an earlier upload that answers last never puts back an older picture. A
 * failure keeps the picture there was and says why.
 */
export function AccountPicture({ account }: { account: Account }) {
  const [version, setVersion] = useState(account.pictureVersion);
  const [busy, setBusy] = useState<"change" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  async function write(file: File | null) {
    const request = ++latest.current;
    setBusy(file ? "change" : "remove"); setError(null);
    try {
      const updated = await pictureWrite(file);
      if (request !== latest.current) return;
      setVersion(updated.pictureVersion);
      // The side menu reads the account again, as for a new name.
      window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: updated.name }));
    } catch (cause) {
      if (request === latest.current) setError(failureMessage(cause));
    } finally {
      if (request === latest.current) setBusy(null);
    }
  }
  return <div id="set-picture" className={styles.row}>
    <div className={styles.picture}>
      <Face person={{ sqlName: account.sqlName, pictureVersion: version }} letters={accountInitials(account.name)} className={styles.face} />
      <div className={styles.side}>
        <div className={styles.actions} role="group" aria-label="Picture">
          <Button busy={busy === "change"} onClick={() => chooser.current?.click()}>Change</Button>
          {version && <Button variant="quiet" busy={busy === "remove"} onClick={() => void write(null)}>Remove</Button>}
        </div>
        <Note>Pictures are cropped to a square.</Note>
      </div>
      <input ref={chooser} type="file" accept={KINDS} hidden aria-label="Choose a picture" data-picture-file onChange={event => {
        const file = event.target.files?.[0] ?? null;
        event.target.value = "";
        if (file) void write(file);
      }} />
    </div>
    {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
  </div>;
}
