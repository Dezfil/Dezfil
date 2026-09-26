"use client";

import { useEffect, useState } from "react";
import { DISPLAY_NAME_EVENT } from "./UserBadge";
import { INSTANCE_NAME_EVENT } from "./shell/path-model";
import { readApiError } from "./api";
import { ErrorNote } from "./ui/ErrorNote";
import styles from "./SettingsScreen.module.css";
import { serverUnreachable } from "./failure-copy";

/* Settings, split Workspace / Profile: the
   workspace card holds the instance's optional name (the chip by the
   wordmark and the browser-title tail) with the coming-later list; the
   profile card keeps the display name whose initials badge the rail
   avatar, unchanged. */
const LATER = [
  "Appearance",
  "Default basemap",
  "API keys",
  "Members & sharing",
];

export function SettingsScreen() {
  const [name, setName] = useState("");
  const [instance, setInstance] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [instanceSaving, setInstanceSaving] = useState(false);
  const [instanceSaved, setInstanceSaved] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);
  // A load failure retries (the request can be reissued); a save failure
  // dismisses (it describes a completed attempt).
  const [error, setError] = useState<{
    message: string;
    retryable: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let response: Response;
        try {
          response = await fetch("/api/settings");
        } catch {
          throw new Error(serverUnreachable("load the settings"));
        }
        if (!response.ok) throw new Error(await readApiError(response));
        const body = (await response.json()) as {
          displayName: string;
          instanceName?: string | null;
        };
        if (!cancelled) {
          setName(body.displayName);
          setInstance(body.instanceName ?? "");
          setLoaded(true);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          // The field stays locked: unlocking over data that never arrived
          // lets a blind save overwrite the stored name. The retry is the
          // recovery path.
          setError({
            message:
              e instanceof Error
                ? e.message
                : serverUnreachable("load the settings"),
            retryable: true,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      if (!response.ok) {
        setError({
          message: await readApiError(response),
          retryable: false,
        });
        return;
      }
      const body = (await response.json()) as { displayName: string };
      setName(body.displayName);
      // The rail avatar listens and re-initials itself without a reload.
      window.dispatchEvent(
        new CustomEvent(DISPLAY_NAME_EVENT, { detail: body.displayName }),
      );
      setSaved(true);
    } catch {
      setError({
        message: serverUnreachable("save the name"),
        retryable: false,
      });
    } finally {
      setSaving(false);
    }
  };

  const saveInstance = async () => {
    setInstanceSaving(true);
    setInstanceError(null);
    setInstanceSaved(false);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: instance }),
      });
      if (!response.ok) {
        setInstanceError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as {
        instanceName?: string | null;
      };
      const stored = body.instanceName ?? null;
      setInstance(stored ?? "");
      // The header chip and every open tab title follow without a
      // reload; deliberately not the display name's event.
      window.dispatchEvent(
        new CustomEvent(INSTANCE_NAME_EVENT, { detail: stored }),
      );
      setInstanceSaved(true);
    } catch {
      setInstanceError(serverUnreachable("save the instance name"));
    } finally {
      setInstanceSaving(false);
    }
  };

  return (
    <div className={styles.screen}>
      <div className={styles.heading}>
        <h1>Settings</h1>
        <p>Workspace preferences. Most settings arrive with later phases.</p>
      </div>

      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          void saveInstance();
        }}
      >
        <h2>Workspace</h2>
        <label className={styles.field}>
          <span>Instance name</span>
          <input
            value={instance}
            disabled={!loaded}
            maxLength={80}
            onChange={(e) => {
              setInstance(e.target.value);
              setInstanceSaved(false);
            }}
          />
        </label>
        <p className={styles.note}>
          Shown by the wordmark and in browser tab titles. Leave empty to
          keep the instance unnamed.
        </p>
        {instanceError && (
          <ErrorNote
            message={instanceError}
            onDismiss={() => setInstanceError(null)}
          />
        )}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.saveBtn}
            disabled={instanceSaving || !loaded}
          >
            {instanceSaving ? "Saving…" : "Save"}
          </button>
          {instanceSaved && (
            <span className={styles.savedNote} role="status">
              Saved
            </span>
          )}
        </div>
        <ul className={styles.laterList}>
          {LATER.map((item) => (
            <li key={item} className={styles.laterRow}>
              <span>{item}</span>
              <span className={styles.soon}>coming soon</span>
            </li>
          ))}
        </ul>
      </form>

      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2>Profile</h2>
        <label className={styles.field}>
          <span>Display name</span>
          <input
            value={name}
            disabled={!loaded}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p className={styles.note}>
          Real accounts and profile images arrive with the multi-user phase.
        </p>
        {error && (
          <ErrorNote
            message={error.message}
            onRetry={
              error.retryable
                ? () => {
                    setError(null);
                    setAttempt((n) => n + 1);
                  }
                : undefined
            }
            onDismiss={error.retryable ? undefined : () => setError(null)}
          />
        )}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.saveBtn}
            disabled={saving || !loaded || !name.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && (
            <span className={styles.savedNote} role="status">
              Saved
            </span>
          )}
        </div>
      </form>

    </div>
  );
}
