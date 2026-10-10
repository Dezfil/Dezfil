"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CustomBasemap } from "@/lib/metadata/maps";
import type { StyleInspection } from "@/lib/net/inspect-style";
import styles from "./CustomBasemapSection.module.css";

/**
 * The basemap picker's sixth card: a dashed Custom card that expands an
 * inline URL + name form with a server check, becomes a real named tile
 * once saved, and offers change/remove. Contextual reveal — no dialog,
 * no permanently visible field. The check is advisory (the save
 * re-inspects server-side); its verdicts decide the wording here:
 * not-a-style blocks, unreachable and blocked warn and can be forced —
 * every reader's browser fetches the style itself. While the instance
 * takes no style address the library does not offer, the door and Change
 * are disabled and say why; a saved style can still be removed.
 */
export function CustomBasemapSection({
  custom,
  onSave,
  onRemove,
  refusal = null,
}: {
  custom: CustomBasemap | null;
  /** PATCH the custom style; resolves false when the write failed. */
  onSave: (body: {
    url: string;
    name: string | null;
    force?: boolean;
  }) => Promise<boolean>;
  onRemove: () => void;
  /** Why no style address can be pasted now, or null while one can. */
  refusal?: string | null;
}) {
  const refusalId = useId();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<StyleInspection | null>(null);
  const [saving, setSaving] = useState(false);
  const checkSeq = useRef(0);
  const checkAbort = useRef<AbortController | null>(null);
  const invalidateCheck = useCallback(() => {
    checkSeq.current++;
    checkAbort.current?.abort();
    checkAbort.current = null;
  }, []);
  useEffect(() => invalidateCheck, [invalidateCheck]);

  const open = () => {
    setUrl(custom?.url ?? "");
    setName(custom?.name ?? "");
    setVerdict(null);
    setEditing(true);
  };
  const close = () => {
    setEditing(false);
    setVerdict(null);
    setChecking(false);
    invalidateCheck();
  };

  const check = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    invalidateCheck();
    const seq = checkSeq.current;
    const controller = new AbortController();
    checkAbort.current = controller;
    setChecking(true);
    setVerdict(null);
    try {
      const response = await fetch("/api/basemap/inspect", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const result = (await response.json()) as StyleInspection & {
        error?: { message: string };
      };
      if (controller.signal.aborted || seq !== checkSeq.current) return; // a newer check took over
      setVerdict(
        response.ok
          ? result
          : {
              verdict: "not_style",
              detail: result.error?.message ?? "The check failed.",
            },
      );
    } catch {
      if (!controller.signal.aborted && seq === checkSeq.current) {
        setVerdict({
          verdict: "unreachable",
          detail: "The check request itself failed.",
        });
      }
    } finally {
      if (seq === checkSeq.current) {
        checkAbort.current = null;
        setChecking(false);
      }
    }
  }, [url, invalidateCheck]);

  const save = async (force: boolean) => {
    setSaving(true);
    const ok = await onSave({
      url: url.trim(),
      name: name.trim() ? name.trim() : null,
      ...(force ? { force: true } : {}),
    });
    setSaving(false);
    if (ok) close();
  };

  const refused = refusal !== null;
  const why = refused ? (
    <p id={refusalId} className={styles.refusal}>
      {refusal}
    </p>
  ) : null;

  // The saved tile.
  if (custom && (!editing || refused)) {
    return (
      <>
        <div className={styles.saved} data-active>
          <span className={styles.savedName}>
            {custom.name ?? hostnameOf(custom.url)}
          </span>
          <span className={styles.savedUrl}>{hostnameOf(custom.url)}</span>
          <span className={styles.savedActions}>
            <button
              type="button"
              className={styles.action}
              onClick={open}
              disabled={refused}
              aria-describedby={refused ? refusalId : undefined}
            >
              Change
            </button>
            <button type="button" className={styles.action} onClick={onRemove}>
              Remove
            </button>
          </span>
        </div>
        {why}
      </>
    );
  }

  // The dashed door.
  if (!editing || refused) {
    return (
      <>
        <button
          type="button"
          className={styles.door}
          onClick={open}
          disabled={refused}
          aria-describedby={refused ? refusalId : undefined}
        >
          <span className={styles.doorPlus}>+</span>
          <span>Custom…</span>
        </button>
        {why}
      </>
    );
  }

  // The inline form.
  const canForce =
    verdict?.verdict === "unreachable" || verdict?.verdict === "blocked";
  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Style URL</span>
        <input
          type="url"
          className={styles.input}
          placeholder="https://…/style.json"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setVerdict(null);
            // A check in flight is for the old URL — invalidate it, or
            // its verdict lands on the edited value.
            invalidateCheck();
            setChecking(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void check();
          }}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name (optional)</span>
        <input
          type="text"
          className={styles.input}
          placeholder="Company dark"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.action}
          disabled={checking || !url.trim()}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check"}
        </button>
        <button type="button" className={styles.action} onClick={close}>
          Cancel
        </button>
      </div>
      {verdict?.verdict === "valid" && (
        <div className={styles.verdict} data-tone="ok">
          <p>
            {verdict.name ?? "A MapLibre style"} · {verdict.layerCount}{" "}
            {verdict.layerCount === 1 ? "layer" : "layers"} ·{" "}
            {verdict.sourceCount}{" "}
            {verdict.sourceCount === 1 ? "source" : "sources"}
          </p>
          <p className={styles.credit}>
            Credit:{" "}
            {(verdict.attribution.length
              ? verdict.attribution.map((line) => line.label)
              : [hostnameOf(url)]
            ).join(" · ")}
          </p>
          <button
            type="button"
            className={styles.save}
            disabled={saving}
            onClick={() => void save(false)}
          >
            {saving ? "Saving…" : "Use this style"}
          </button>
        </div>
      )}
      {verdict?.verdict === "not_style" && (
        <div className={styles.verdict} data-tone="bad">
          <p>{verdict.detail}</p>
        </div>
      )}
      {canForce && (
        <div className={styles.verdict} data-tone="warn">
          <p>
            {verdict.verdict === "blocked"
              ? "This instance's egress policy blocks the check. Private " +
                "and internal addresses are denied unless the allowlist " +
                "names them."
              : `Could not verify the style (${verdict.detail})`}{" "}
            Readers&apos; browsers fetch the style themselves, so it may
            still work.
          </p>
          <button
            type="button"
            className={styles.save}
            disabled={saving}
            onClick={() => void save(true)}
          >
            {saving ? "Saving…" : "Use anyway"}
          </button>
        </div>
      )}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
