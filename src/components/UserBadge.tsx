"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Account } from "@/lib/metadata/accounts";
import { IconButton } from "./ui/IconButton";
import { ErrorNote } from "./ui/ErrorNote";
import { Face } from "./people/Face";
import { SignOutIcon } from "./ui/icons";
import { accountRequest, failureMessage } from "./settings/api";
import { ACCOUNT_ADDRESS } from "./settings/settings-address";
import styles from "@/app/(workspace)/layout.module.css";
import { accountChanged } from "./auth/private-state";
import { railHint, useRailItemMode } from "./rail-mode";

/** Profile changes refresh the rail without a navigation. */
export const DISPLAY_NAME_EVENT = "dezfil:display-name";

/** A person's own initials, as the side menu and the Account card draw
 * them: the first letters of the first two words of the name. */
export function accountInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(word => word[0].toUpperCase()).join("") || "?";
}

/** The expanded avatar row carries the account and its sign-out action.
 * The avatar is the person's face: their picture, or their initials. */
export function UserBadge({ account }: { account: Account | null }) {
  const pathname = usePathname();
  const mode = useRailItemMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signOut() {
    setBusy(true); setError(null);
    try {
      await accountRequest("/api/auth/sign-out", "POST");
      accountChanged();
      window.location.replace(new URL("/sign-in", window.location.origin).href);
    } catch (error) { setError(failureMessage(error)); setBusy(false); }
  }
  return <div className={styles.accountRow}>
    <Link href={ACCOUNT_ADDRESS} className={styles.railLink}
      data-active={pathname === ACCOUNT_ADDRESS || undefined}
      aria-label={account ? `${account.name}, account` : "Account"}
      {...railHint(mode, account?.name ?? "Account")}>
      <span className={styles.railIcon}>{account
        ? <Face person={account} letters={accountInitials(account.name)} className={styles.avatar} />
        : <span className={styles.avatar} aria-hidden />}</span>
      <span className={`${styles.railLabel} ${styles.accountLabel}`}>
        <b>{account?.name ?? "…"}</b>
      </span>
    </Link>
    <IconButton action="Sign out" tone="chrome" hint icon={<SignOutIcon />} className={styles.accountOut}
      disabled={busy} aria-busy={busy || undefined} onClick={signOut} />
    {error && createPortal(<div className={styles.accountError}>
      <ErrorNote message={error} onRetry={() => void signOut()} onDismiss={() => setError(null)} />
    </div>, document.body)}
  </div>;
}
