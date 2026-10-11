"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  formatBbox,
  formatCoords,
  formatZoom,
  type StatusChannel,
} from "@/lib/map-status";
import {
  failureProse,
  type AnswerState,
} from "../widgets/dashboard-state";
import {
  useStatusPriority,
  type StatusKey,
} from "./use-status-priority";
import styles from "./StatusBar.module.css";

interface Props {
  channel: StatusChannel;
  /** Widget-constrained record counts: every active constraint
   * — stored filters and selections — reflected in one truthful readout.
   * Null hides the segment (no widgets on the map). */
  records?: { count: number; total: number } | null;
  /** Truth state of the counts: updating dims them as stale;
   * failed replaces them — a kept number is not the current answer. */
  recordsState?: AnswerState;
  /** The basemap credit in the stage's lower-right corner, which the pill
   * keeps clear of. */
  credit?: HTMLElement | null;
}

/** Which readout just copied, and whether the clipboard cooperated. */
type Flash = { key: "coords" | "bbox"; ok: boolean } | null;

const FLASH_MS = 1400;

/**
 * Builder status pill: live cursor coordinates, zoom, and viewport bbox
 * floating over the canvas. Coordinates and bbox copy on click as bare
 * comma-separated numbers — ready for a SQL filter. Subscribes to the
 * canvas's status channel directly, so view changes re-render only this
 * pill. The basemap credit lives in the map's own corner, not here.
 *
 * When width runs out the pill drops items whole, lowest priority first:
 * pitch, then bbox, then records, then zoom — coords survives last, and
 * the pill vanishes entirely rather than clip. Beside the basemap credit
 * it slides left in its band rather than cover it, and the room left of
 * the credit is the width it has. The probe row below holds
 * every present item at natural size, invisibly, so capacity is measured
 * independently of what is shown.
 */
export function StatusBar({
  channel,
  records = null,
  recordsState = { status: "current", error: null },
  credit = null,
}: Props) {
  const status = useSyncExternalStore(
    channel.subscribe,
    channel.get,
    () => null,
  );
  const [flash, setFlash] = useState<Flash>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async (key: "coords" | "bbox", text: string) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false;
    }
    setFlash({ key, ok });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  const coords = status?.cursor ? formatCoords(status.cursor) : null;
  const bbox = status ? formatBbox(status.bounds) : null;

  const recordsPresent = !!records || recordsState.status === "failed";
  const pitchPresent = (status?.pitch ?? 0) > 0;
  const present: StatusKey[] = [
    ...(recordsPresent ? (["records"] as const) : []),
    "coords",
    "zoom",
    ...(pitchPresent ? (["pitch"] as const) : []),
    "bbox",
  ];
  const { probeRef, itemRef, visible, shift } = useStatusPriority(present, credit);

  const value = (key: "coords" | "bbox", text: string | null) =>
    flash?.key === key ? (
      <span className={styles.flash} data-ok={flash.ok}>
        {flash.ok ? "copied" : "couldn't copy"}
      </span>
    ) : (
      <span className={styles.val}>{text ?? "—"}</span>
    );

  /** One rendering of the items serves both rows: the probe measures
   * every present item; the visible bar renders the surviving subset in
   * the same document order. */
  const items = (opts: { measure: boolean }) => {
    const show = (key: StatusKey) => opts.measure || visible.includes(key);
    const ref = (key: StatusKey) => (opts.measure ? itemRef(key) : undefined);
    // The probe must never double a hook or a tooltip: attributes carry
    // no width, and a test's strict locator (or a stray native tooltip
    // from an invisible row) must resolve to the visible bar alone.
    const hook = <T,>(value: T): T | undefined =>
      opts.measure ? undefined : value;
    return (
      <>
        {/* The failed readout must survive a first fetch that never
            succeeded — there are no counts to carry, and disappearing
            would be the silence exists to remove. A map with no widgets
            never reaches the failed state. */}
        {recordsPresent && show("records") && (
          <span
            className={styles.item}
            ref={ref("records")}
            data-records={hook("true")}
            data-stale={
              recordsState.status === "updating" ? hook("") : undefined
            }
          >
            <span className={styles.key}>Records</span>
            {recordsState.status === "failed" ? (
              <span
                className={styles.val}
                data-failed={hook("true")}
                title={hook(failureProse(recordsState.error, "author"))}
              >
                unavailable
              </span>
            ) : (
              records && (
                <span className={styles.val}>
                  {records.count < records.total
                    ? `${records.count.toLocaleString()} of ${records.total.toLocaleString()}`
                    : records.total.toLocaleString()}
                </span>
              )
            )}
          </span>
        )}
        {show("coords") && (
          <button
            className={styles.copy}
            ref={ref("coords")}
            data-hint={hook("Copy coordinates")}
            data-hint-always={hook("")}
            aria-describedby={opts.measure ? undefined : "status-copy-coords"}
            disabled={!coords}
            onClick={() => coords && void copy("coords", coords)}
          >
            <span className={styles.key}>Coords</span>
            {value("coords", coords)}
            {/* The action's description, for readers — the styled hint
                is visual-only. */}
            {!opts.measure && (
              <span id="status-copy-coords" hidden>
                Copy coordinates
              </span>
            )}
          </button>
        )}
        {show("zoom") && (
          <span className={styles.item} ref={ref("zoom")}>
            <span className={styles.key}>Zoom</span>
            <span className={styles.val} data-status-zoom={hook("true")}>
              {status ? formatZoom(status.zoom) : "—"}
            </span>
          </span>
        )}
        {pitchPresent && show("pitch") && (
          <span className={styles.item} ref={ref("pitch")}>
            <span className={styles.key}>Pitch</span>
            <span className={styles.val}>{status?.pitch}°</span>
          </span>
        )}
        {show("bbox") && (
          <button
            className={styles.copy}
            ref={ref("bbox")}
            data-hint={hook("Copy bounding box")}
            data-hint-always={hook("")}
            aria-describedby={opts.measure ? undefined : "status-copy-bbox"}
            disabled={!bbox}
            onClick={() => bbox && void copy("bbox", bbox)}
          >
            <span className={styles.key}>BBox</span>
            {value("bbox", bbox)}
            {!opts.measure && (
              <span id="status-copy-bbox" hidden>
                Copy bounding box
              </span>
            )}
          </button>
        )}
      </>
    );
  };

  return (
    <>
      <div className={styles.probe} ref={probeRef} inert aria-hidden>
        {items({ measure: true })}
      </div>
      {visible.length > 0 && (
        <div
          className={styles.bar}
          data-status-bar
          style={shift > 0 ? ({ "--pill-shift": `${shift}px` } as CSSProperties) : undefined}
        >
          {items({ measure: false })}
        </div>
      )}
    </>
  );
}
