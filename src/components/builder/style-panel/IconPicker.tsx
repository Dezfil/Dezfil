"use client";

import { useRef, useState } from "react";
import { MAKI_CATEGORIES, makiUrl } from "@/lib/maki";
import type { IconViz } from "@/lib/viz";
import type { SanitizedIcon } from "@/lib/icon-sanitize";
import { PlusIcon } from "../../ui/icons";
import styles from "./IconPicker.module.css";

/**
 * The icon layer's picker (extracted from StylePanel as at-touch
 * slice): the curated Maki grid, plus the contextual Custom reveal
 * (paste door removed by a field note) — drop an.svg on
 * the box or click it to choose a file; the advisory sanitizer previews
 * the accepted mark as an encoded image with a bounded report of what
 * it dropped; accepting stores the sanitized markup on the viz, where
 * it wins over the glyph until cleared. The custom mark tints through
 * the fill channel like any glyph — a multi-color SVG flattens to a
 * silhouette, said once below, plainly.
 */
export function IconPicker({
  viz,
  onViz,
}: {
  viz: IconViz;
  onViz: (viz: IconViz) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<SanitizedIcon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Only the LATEST user action may update state: a slow file read or
  // sanitize response must not land its verdict on a newer input, or
  // "Use this icon" saves the wrong mark.
  const submitSeq = useRef(0);
  const custom = viz.customSvg ?? null;

  const submit = async (svg: string, seq: number) => {
    if (seq !== submitSeq.current) return;
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      const response = await fetch("/api/icons/sanitize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ svg }),
      });
      const body = (await response.json()) as SanitizedIcon & {
        error?: { message: string };
      };
      if (seq !== submitSeq.current) return;
      if (!response.ok) {
        setError(body.error?.message ?? "The SVG could not be accepted.");
        return;
      }
      setPending(body);
    } catch {
      if (seq === submitSeq.current) setError("The check request failed.");
    } finally {
      if (seq === submitSeq.current) setBusy(false);
    }
  };

  const begin = (): number => ++submitSeq.current;

  const readFile = (file: File | undefined) => {
    if (!file) return;
    const seq = begin();
    void file.text().then((text) => void submit(text, seq));
  };

  const preview = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.glyphPicker}>
        {MAKI_CATEGORIES.map((category) => (
          <div key={category.label}>
            <span className={styles.glyphGroupLabel}>{category.label}</span>
            <div className={styles.glyphGrid}>
              {category.glyphs.map((glyph) => (
                <button
                  key={glyph}
                  className={styles.glyphBtn}
                  data-active={custom === null && viz.glyph === glyph}
                  title={glyph}
                  aria-label={glyph}
                  onClick={() =>
                    // Picking a glyph while a custom mark is active is
                    // an explicit choice to leave it (the lesson: cards
                    // that appear dead are a defect).
                    onViz({ ...viz, glyph, customSvg: null })
                  }
                >
                  <i
                    style={{
                      WebkitMaskImage: `url(${makiUrl(glyph)})`,
                      maskImage: `url(${makiUrl(glyph)})`,
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.customSection}>
        <span className={styles.glyphGroupLabel}>Custom</span>
        {custom !== null && (
          <div className={styles.savedRow}>
            <i
              className={styles.savedMark}
              style={{
                WebkitMaskImage: `url(${preview(custom)})`,
                maskImage: `url(${preview(custom)})`,
              }}
            />
            <span className={styles.savedText}>Your icon</span>
            <button
              type="button"
              className={styles.action}
              onClick={() => setOpen(true)}
            >
              Change
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                onViz({ ...viz, customSvg: null });
                setOpen(false);
              }}
            >
              Remove
            </button>
          </div>
        )}
        {!open && custom === null && (
          <button
            type="button"
            className={styles.door}
            onClick={() => setOpen(true)}
          >
            <PlusIcon /> Custom…
          </button>
        )}
        {open && (
          <div
            className={styles.dropZone}
            data-busy={busy || undefined}
            // The whole box is the door (a field note:
            // the paste textarea is gone) — a click anywhere that is not
            // one of the inner actions opens the file chooser.
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest("button")) {
                fileInput.current?.click();
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              readFile(e.dataTransfer.files?.[0]);
            }}
          >
            <p className={styles.dropHint}>
              Drop an .svg here, or click to choose a file.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".svg,image/svg+xml"
              aria-label="Choose an SVG file"
              className={styles.fileInput}
              onChange={(e) => {
                readFile(e.target.files?.[0] ?? undefined);
                e.target.value = "";
              }}
            />
            {busy && <p className={styles.note}>Checking…</p>}
            {error && (
              <p className={styles.note} data-tone="bad">
                {error}
              </p>
            )}
            {pending && (
              <div className={styles.pending}>
                <i
                  className={styles.savedMark}
                  style={{
                    WebkitMaskImage: `url(${preview(pending.svg)})`,
                    maskImage: `url(${preview(pending.svg)})`,
                  }}
                />
                {pending.dropped.length > 0 && (
                  <p className={styles.note} data-tone="warn">
                    Removed:{" "}
                    {pending.dropped
                      .map((d) => `${d.name} (${d.kind})`)
                      .join(", ")}
                  </p>
                )}
                <button
                  type="button"
                  className={styles.use}
                  onClick={() => {
                    onViz({ ...viz, customSvg: pending.svg });
                    setPending(null);
                    setOpen(false);
                  }}
                >
                  Use this icon
                </button>
              </div>
            )}
            <p className={styles.note}>
              Multi-color SVGs flatten to a silhouette.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
