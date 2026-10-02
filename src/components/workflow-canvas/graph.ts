import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { formatRelativeTime } from "../api";
import { nodeState, type ChipTone, type WorkflowStep } from "../workflow-model";
import type { RunMemberOverlay, RunOverlay } from "./run-overlay";
import { normalName, producerOf, producersByName, readKey, readTarget, sourceId } from "../workflow-producers";

/**
 * The canvas's graph: what is on the canvas and how it is joined, derived
 * from the four documented reads and nothing else. No SQL is parsed here
 * and no condition is inferred; every fact comes from the recipe read
 * (present reads, recorded lineage, conditions with their causes, missing
 * inputs, the latest attempt, a pending edit), the layout document (loose
 * sources), the tables list (a source's rows, geometry, and existence) and
 * the catalog (a node's label, group, ports).
 *
 * Edge presentation is **composable**, not one enum: attachment (a named
 * port or the SQL node's side), time (present, proposed, or recorded
 * lineage no longer read) and condition (broken, stale) are independent
 * facts, and case needs a broken *proposed* edge.
 */

export type LayoutInput = {
  steps: Record<string, { x: number; y: number }>;
  sources: Record<string, { x: number; y: number }>;
};

export interface GraphInput {
  steps: WorkflowStep[];
  layout: LayoutInput;
  /** The run in flight, as the tiles wear it; null when none. */
  run?: RunOverlay | null;
  /** Null while the listing has not been read: a source is then never
   * missing on the listing's account. */
  tables: TableListing[] | null;
  operations: OperationDef[];
  /** The SQL name of the workflow's home, where its plain names live. */
  home?: string | null;
}

export type StateWord =
  | "running"
  | "queued"
  | "waiting"
  | "cancelled"
  | "not run"
  | "cannot run"
  | "run failed"
  | "output deleted"
  | "output not available"
  | "stale"
  | "edited"
  | "never run"
  | "up to date";

/** The badge the Badge tile wears for a state word (reference 12). */
export type BadgeGlyph = "spinner" | "warn" | "rerun" | "edit" | "check" | null;

export interface NodePort {
  name: string;
  label: string;
  /** The table the input is set to, from the effective definition. */
  value: string | null;
}

export interface NodeMember {
  kind: "node";
  id: string;
  step: WorkflowStep;
  label: string;
  group: string | null;
  symbol: string;
  /** The dataset's name once produced, the declared name before. */
  outputName: string;
  state: { word: StateWord; tone: ChipTone; badge: BadgeGlyph };
  /** The run in flight's word and reason for this node, while it is shown. */
  run: RunMemberOverlay | null;
  /** Every condition true of it and its last successful run, in words. */
  disclosure: string;
  ports: NodePort[];
  /** The SQL node reads what its query names: no ports. */
  sql: boolean;
}

export interface SourceMember {
  kind: "source";
  id: string;
  name: string;
  table: { rowCount: number; geometryType: string | null; geometryColumn: string | null } | null;
  /** The listed dataset the name points at, and the name its reader types
   * for it; null when the listing holds no such dataset. */
  tableId: string | null;
  typedName: string | null;
  /** The SQL name of the space the name points at: its qualifier, else the
   * workflow's home; null when the home is not known. */
  space: string | null;
  missing: boolean;
  /** Positioned by the layout though nothing reads it. */
  loose: boolean;
  /** Named only by recorded lineage a node no longer reads. */
  lineageOnly: boolean;
}

export type CanvasMember = NodeMember | SourceMember;

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  /** The table the edge carries. */
  table: string;
  attachment: { kind: "port"; port: string } | { kind: "sql" };
  time: "present" | "proposed" | "lineage";
  broken: boolean;
  stale: boolean;
}

export interface CanvasGraph {
  members: CanvasMember[];
  edges: CanvasEdge[];
  /** Distinct present external reads — the API summary's source count. */
  presentSourceCount: number;
  /** The SQL name of the workflow's home, where its plain names live;
   * null or absent when it is not known. */
  home?: string | null;
}

const BADGE: Record<StateWord, BadgeGlyph> = {
  running: "spinner",
  queued: null,
  waiting: null,
  cancelled: "warn",
  "not run": "warn",
  "cannot run": "warn",
  "run failed": "warn",
  "output deleted": "rerun",
  "output not available": null,
  stale: "rerun",
  edited: "edit",
  "never run": null,
  "up to date": "check",
};

const CONDITION_WORD: Record<string, string> = {
  broken: "cannot run",
  output_missing: "output deleted",
  output_unavailable: "output not available",
  stale: "stale",
  never_run: "never run",
  current: "up to date",
};

/** The effective definition: a pending edit's when it holds one. */
export function effectiveParameters(step: WorkflowStep): Record<string, unknown> {
  return step.proposedParameters ?? step.parameters;
}

export function outputNameOf(step: WorkflowStep): string {
  if (step.output?.name) return step.output.name;
  const declared = step.parameters.name;
  return typeof declared === "string" ? declared : "";
}

/** Every condition true of the node, in the API's order, plus the attempt
 * and the edit — the words behind the badge. */
export function conditionWords(step: WorkflowStep): string[] {
  const words: string[] = [];
  const attempt = step.latestAttempt?.state ?? null;
  if (attempt === "running" || attempt === "queued") words.push(attempt);
  for (const c of step.conditions) {
    const w = CONDITION_WORD[c];
    if (w && !words.includes(w)) words.push(w);
  }
  if (attempt === "failed") words.push("run failed");
  if (step.proposedParameters) words.push("edited");
  return words;
}

export function disclosureOf(step: WorkflowStep, label: string, outputName: string): string {
  const parts = [label];
  if (outputName) parts.push(outputName);
  parts.push(conditionWords(step).join(", "));
  parts.push(
    step.lastSuccessAt
      ? `last successful run ${formatRelativeTime(step.lastSuccessAt)}`
      : "never run successfully",
  );
  return parts.join(" · ");
}

/**
 * The listed dataset a name written in the workflow's home points at: a
 * plain name the home's, `<sql name>.<dataset>` that person's. Two people's
 * same-named datasets are both in a reader's listing, so the name alone
 * never decides. A listing entry that carries no owner is matched by name.
 */
export function listedFor(tables: readonly TableListing[], written: string, home: string | null | undefined): TableListing | null {
  const target = readTarget(written);
  const owner = target.owner ?? home?.toLowerCase() ?? null;
  const name = normalName(target.name);
  return (
    tables.find((t) => {
      if (normalName(t.name) !== name) return false;
      const listedOwner = t.owner?.sqlName?.toLowerCase();
      return owner === null || listedOwner === undefined || listedOwner === owner;
    }) ?? null
  );
}

export function canvasGraph(input: GraphInput): CanvasGraph {
  const ordered = [...input.steps].sort((a, b) => a.ordinal - b.ordinal);
  const producer = producersByName(ordered);
  const ops = new Map(input.operations.map((o) => [o.id, o]));
  const tables = input.tables;

  // Names the recipe itself reports missing, outright (not through a
  // producer): the authoritative account, whatever the listing says.
  const reportedMissing = new Set<string>();
  for (const s of ordered) {
    for (const m of s.missingInputs) if (!m.throughStepId) reportedMissing.add(readKey(m.tableName));
  }

  const sources = new Map<string, SourceMember>();
  const source = (name: string, how: { loose?: boolean; lineageOnly?: boolean }) => {
    const key = readKey(name);
    let m = sources.get(key);
    if (!m) {
      const t = tables ? listedFor(tables, name, input.home) : null;
      m = {
        kind: "source",
        id: sourceId(name),
        name,
        table: t ? { rowCount: t.rowCount, geometryType: t.geometryType, geometryColumn: t.geometryColumn } : null,
        tableId: t?.id ?? null,
        typedName: t ? t.qualifiedName ?? t.name : null,
        space: readTarget(name).owner ?? input.home?.toLowerCase() ?? null,
        missing: reportedMissing.has(key) || (tables !== null && !t),
        loose: !!how.loose,
        lineageOnly: !!how.lineageOnly,
      };
      sources.set(key, m);
    } else {
      // A present read outranks the other two ways of being here.
      if (!how.loose && !how.lineageOnly) {
        m.loose = false;
        m.lineageOnly = false;
      }
    }
    return m;
  };
  const endpointFor = (name: string): string => {
    const p = producerOf(producer, name);
    return p ?? source(name, {}).id;
  };

  const nodes: NodeMember[] = [];
  const edges: CanvasEdge[] = [];
  const present = new Set<string>();

  for (const s of ordered) {
    const op = ops.get(s.operation) ?? null;
    const label = op?.label ?? s.operation;
    const outputName = outputNameOf(s);
    const st = nodeState(s);
    const run = input.run?.members[s.id] ?? null;
    // While a run is shown, its record's word is the tile's.
    const word = (run ? run.word : st.label) as StateWord;
    const tone = run ? run.tone : st.tone;
    const effective = effectiveParameters(s);
    const ports: NodePort[] = (op?.inputs ?? []).map((i) => ({
      name: i.name,
      label: i.label,
      value: typeof effective[i.name] === "string" ? (effective[i.name] as string) : null,
    }));
    const sql = ports.length === 0;
    nodes.push({
      kind: "node",
      id: s.id,
      step: s,
      label,
      group: op?.group ?? null,
      // A step whose operation the catalog does not serve carries an
      // unknown key, so its tile and panel wear the fallback pictogram
      // rather than borrowing the SQL drawing.
      symbol: op?.symbol ?? "unknown_operation",
      outputName,
      state: { word, tone, badge: BADGE[word] },
      run,
      disclosure: run
        ? `${label} · ${outputName ? `${outputName} · ` : ""}${run.word}${run.reason ? ` · ${run.reason}` : ""}`
        : disclosureOf(s, label, outputName),
      ports,
      sql,
    });

    const staleTables = new Set(s.causes.map((c) => readKey(c.tableName)));
    const lineage = new Set(s.inputs.map((i) => readKey(i.name)));
    const activeValues = new Map<string, string>();
    for (const p of ports) {
      const v = s.parameters[p.name];
      if (typeof v === "string") activeValues.set(p.name, readKey(v));
    }

    // Present reads: one edge per read; a named input's read attaches to
    // its port (two inputs set to one table are two edges), the SQL
    // node's to its side.
    const claimed = new Set<string>();
    const attachFor = (read: string): CanvasEdge["attachment"] => {
      const key = readKey(read);
      const port = ports.find((p) => !claimed.has(p.name) && p.value !== null && readKey(p.value) === key);
      if (!port) return { kind: "sql" };
      claimed.add(port.name);
      return { kind: "port", port: port.name };
    };
    // A port set to a table carries an edge even when the API folded two
    // reads of one table into one name.
    const seenReads: string[] = [];
    for (const read of s.reads) {
      const key = readKey(read);
      // Every port set to this table draws its own edge.
      const matching = ports.filter((p) => p.value !== null && readKey(p.value) === key);
      const count = Math.max(1, matching.length);
      if (seenReads.includes(key)) continue;
      seenReads.push(key);
      for (let i = 0; i < count; i++) {
        const attachment = attachFor(read);
        const from = endpointFor(read);
        if (producerOf(producer, read) === undefined) present.add(key);
        const proposed =
          s.proposedParameters !== null &&
          (attachment.kind === "port"
            ? activeValues.get(attachment.port) !== key
            : s.output !== null && !lineage.has(key));
        const fromMember = sources.get(key);
        edges.push({
          id: `${from}->${s.id}:${attachment.kind === "port" ? attachment.port : "sql"}:${i}`,
          from,
          to: s.id,
          table: read,
          attachment,
          time: proposed ? "proposed" : "present",
          broken: !!fromMember?.missing,
          stale: staleTables.has(key),
        });
      }
    }
    // Recorded lineage the present reads no longer name stays visible as
    // "built from" — only where a pending edit moved the definition away.
    if (s.proposedParameters !== null && s.output !== null) {
      for (const input of s.inputs) {
        const key = readKey(input.name);
        if (seenReads.includes(key)) continue;
        const p = producerOf(producer, input.name);
        const from = p ?? source(input.name, { lineageOnly: true }).id;
        // A named-input node draws its lineage into the port that read the
        // table (the active definition's), or its first port: the SQL side
        // exists only on the SQL node.
        const oldPort =
          ports.find((port) => activeValues.get(port.name) === key)?.name ?? ports[0]?.name;
        edges.push({
          id: `${from}->${s.id}:lineage`,
          from,
          to: s.id,
          table: input.name,
          attachment: sql || !oldPort ? { kind: "sql" } : { kind: "port", port: oldPort },
          time: "lineage",
          broken: !!sources.get(key)?.missing,
          stale: staleTables.has(key),
        });
      }
    }
  }

  // Loose tables the layout positions though nothing reads them.
  for (const name of Object.keys(input.layout.sources)) {
    const key = readKey(name);
    if (producerOf(producer, name) !== undefined || sources.has(key)) continue;
    source(name, { loose: true });
  }

  return {
    members: [...sources.values(), ...nodes],
    edges,
    presentSourceCount: present.size,
    home: input.home ?? null,
  };
}
