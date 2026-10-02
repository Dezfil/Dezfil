"use client";

import Link from "next/link";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { geometryGlyphType } from "../geometry-class";
import { ExternalIcon, XIcon } from "../ui/icons";
import { GeometryGlyph } from "../ui/operation-icons";
import { formatCount } from "../api";
import type { CanvasGraph, NodeMember, SourceMember } from "./graph";
import { useTableFacts } from "./use-table-facts";
import styles from "./WorkflowCanvas.module.css";

/**
 * The source panel: rows, geometry, where the table came from and its
 * columns, from the documented table read; the nodes reading it as
 * chips that select the reader; the Data Explorer; and *Remove from
 * canvas*, offered only for a loose source neither a present read nor a
 * recorded lineage requires. A missing table is said to be missing,
 * with no invented facts.
 */
export function SourcePanel({
  member,
  graph,
  onSelect,
  onClose,
  onRemove,
  lockReason = null,
}: {
  member: SourceMember;
  graph: CanvasGraph;
  onSelect: (memberId: string) => void;
  onClose: () => void;
  onRemove: (member: SourceMember) => void;
  /** The canvas lock's reason while locked. */
  lockReason?: string | null;
}) {
  // The dataset by the name its reader types: the home's `roads` is
  // someone else's when the reader is not the home, and a bare name would
  // read the reader's own.
  const read = useTableFacts(member.missing ? null : member.typedName);
  // A node reading the table through two ports is one reader.
  const readers = graph.edges
    .filter((e) => e.from === member.id && e.time !== "lineage")
    .map((e) => graph.members.find((m) => m.id === e.to))
    .filter((m): m is NodeMember => !!m && m.kind === "node")
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
  const lineage = graph.edges.some((e) => e.from === member.id && e.time === "lineage");
  const removable = member.loose && readers.length === 0 && !lineage;
  const facts = read.state === "read" ? read.facts : null;
  const geometryColumn = facts
    ? facts.geometryColumn
    : member.table?.geometryColumn ?? null;
  const geometryType = facts
    ? facts.geometryType
    : member.table?.geometryType || null;
  const geometry =
    geometryColumn === null ? "none, a table" : geometryType || "unknown";
  return (
    <aside className={styles.inspector} aria-label={`${member.name}, source`} data-source-panel>
      <header className={styles.inspHead}>
        <span className={styles.inspTile} data-kind={member.missing ? "missing" : geometryColumn !== null ? "geo" : "none"}>
          <GeometryGlyph
            geometryType={geometryGlyphType(
              member.missing ? null : { geometryType, geometryColumn },
            )}
          />
        </span>
        <h3>{member.name}</h3>
        <IconButton action="Close panel" icon={<XIcon />} onClick={onClose} />
      </header>
      <div className={styles.inspBody}>
        {member.missing ? (
          <p className={styles.callout} data-tone="bad">
            <b>This table no longer exists.</b> {readers.length === 0 ? "Nothing on this canvas reads it now." : `${readers.length} node${readers.length === 1 ? "" : "s"} reading it cannot run until it is back or they read something else.`}
          </p>
        ) : null}
        {!member.missing ? (
          <section className={styles.sec} aria-label="Facts">
            <dl className={styles.kvs}>
              <div className={styles.kv}>
                <dt>Rows</dt>
                <dd>{facts ? formatCount(facts.rowCount) : member.table ? formatCount(member.table.rowCount) : "…"}</dd>
              </div>
              <div className={styles.kv}>
                <dt>Geometry</dt>
                <dd data-plain>{geometry.toLowerCase().replace(/_/g, " ")}</dd>
              </div>
              <div className={styles.kv}>
                <dt>Source</dt>
                <dd data-plain>
                  {facts
                    ? facts.sourceFilename
                      ? `${facts.sourceFilename} (${facts.format})`
                      : facts.inputs
                        ? "made by a workflow node"
                        : facts.format
                    : "…"}
                </dd>
              </div>
            </dl>
          </section>
        ) : null}
        {!member.missing ? (
          <section className={styles.sec} aria-label="Columns">
            <h4 className={styles.secLabel}>
              Columns {facts ? <span className={styles.cnt}>{facts.columns.length}</span> : null}
            </h4>
            {read.state === "reading" ? <p className={styles.help}>Reading its columns…</p> : null}
            {read.state === "failed" ? (
              <p className={styles.problem} role="alert">
                {read.message}{" "}
                <Button variant="quiet" size="compact" onClick={read.retry} data-retry-read>
                  Retry
                </Button>
              </p>
            ) : null}
            {facts ? (
              <ul className={styles.columns}>
                {facts.columns.map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span>
                    <span className={styles.colType}>{c.type.toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        <section className={styles.sec} aria-label="Read by">
          <h4 className={styles.secLabel}>
            Read by <span className={styles.cnt}>{readers.length}</span>
          </h4>
          {readers.length ? (
            <div className={styles.chips}>
              {readers.map((r) => (
                <button key={r.id} type="button" className={styles.chip} onClick={() => onSelect(r.id)} data-reader-chip>
                  {r.label}
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.help}>Nothing yet. Drag from its port into a node’s input.</p>
          )}
        </section>
        <div className={styles.btnRow}>
          {!member.missing && member.typedName ? (
            <Link href={`/tables/${encodeURIComponent(member.typedName)}`} className={styles.linkBtn} data-open-explorer>
              <ExternalIcon /> Open in Data
            </Link>
          ) : null}
          {removable && !lockReason ? (
            <Button variant="quiet" size="compact" onClick={() => onRemove(member)} data-remove-source>
              Remove from canvas
            </Button>
          ) : null}
          {removable && lockReason ? (
            <p className={styles.help} data-remove-withheld>
              {lockReason}
            </p>
          ) : null}
        </div>
        {!removable && member.loose ? (
          <p className={styles.help}>{lineage ? "A node's recorded lineage names it, so it stays on the canvas." : "A node reads it, so it stays on the canvas."}</p>
        ) : null}
      </div>
    </aside>
  );
}
