"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/app/(workspace)/layout.module.css";

/** Name changes broadcast on this event so the badge follows the settings
 * screen without a reload. */
export const DISPLAY_NAME_EVENT = "dezfil:display-name";

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("") || "?"
  );
}

/** The rail avatar: a profile image when one exists — none can
 * yet — otherwise the display name's initials. Leads to Settings. */
export function UserBadge() {
  const pathname = usePathname();
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { displayName: string } | null) => {
        if (!cancelled && body) setName(body.displayName);
      })
      .catch(() => {
        /* The badge just stays blank until the API is reachable */
      });
    const onRename = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") setName(detail);
    };
    window.addEventListener(DISPLAY_NAME_EVENT, onRename);
    return () => {
      cancelled = true;
      window.removeEventListener(DISPLAY_NAME_EVENT, onRename);
    };
  }, []);

  return (
    <Link
      href="/settings"
      className={styles.railLink}
      data-active={pathname.startsWith("/settings") || undefined}
      aria-label={name ? `${name}, settings` : "Profile, settings"}
    >
      <span className={styles.railIcon}>
        <span className={styles.avatar} aria-hidden>
          {name ? initials(name) : ""}
        </span>
      </span>
      <span className={styles.railLabel}>{name ?? "…"}</span>
    </Link>
  );
}
