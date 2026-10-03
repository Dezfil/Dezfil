import { readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";
import type { Positions } from "./arrange";
import type { CanvasGraph } from "./graph";
import type { LayoutNote, LayoutRead } from "./placement";
import { WorkflowDocument } from "./workflow-document";
import { fieldIntent } from "../document-sequence";

/** What the frame shows while the layout or recipe is being stored. */
export type SaveState =
  | { kind: "stale" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; message: string; retry: () => void };

/** What a write carries: every on-screen position and every note. */
export interface LayoutSnapshot {
  positions: Positions;
  notes: LayoutNote[];
}

export interface LayoutSaves {
  /** A completed move, Arrange, or a note change: write this snapshot. */
  save: (snapshot: LayoutSnapshot) => void;
  /** A loose source placed: its name beside its id, so
   * the write can carry it before the graph holds it. */
  placeSource: (id: string, name: string, snapshot: LayoutSnapshot) => void;
  /** A loose source removed from the canvas: the
   * next write leaves its position out, beside every other position. */
  dropSource: (name: string, snapshot: LayoutSnapshot) => void;
  /** A removed node: its position leaves the layout
   * with the next write, before the recipe's re-read lands. */
  dropStep: (id: string, snapshot: LayoutSnapshot) => void;
  /** A step of the record put back: the loose
   * sources it brings back travel the placement road and the ones it
   * takes away the drop road, and the snapshot is written once. */
  restore: (snapshot: LayoutSnapshot, roads: { place: { id: string; name: string }[]; drop: string[] }) => void;
  /** Whether a write is on the wire or waiting. While it is, a layout
   * echo may be older than the screen: no reseed from it (found at review). */
  pending: () => boolean;
}

/** The live screen ports read when a write or Retry acts. */
export interface LayoutSavePorts {
  graph: CanvasGraph;
  onState: (state: SaveState) => void;
  onWritten?: (layout: LayoutRead) => void;
  lockReason: () => string | null;
  say: (text: string, tone?: "bad") => void;
}

/**
 * The layout coordinator (the whole snapshot): writes the layout document
 * whole on a completed move, on Arrange, on a source placed or dropped, a
 * node dropped, and on every note change, and at no other time. Saves are
 * serialized: one write on the wire at a time and only the newest waiting
 * snapshot follows it. A failed save keeps the newest snapshot recoverable
 * through the frame's Retry.
 *
 * This plain production module is owned by `useLayoutSaves`; keeping React
 * outside it lets the coordinator's actual fetch road run over the unit
 * harness's answered wire.
 */
export class LayoutSaveCoordinator implements LayoutSaves {
  private base: LayoutRead;
  private current: LayoutSavePorts;
  private latest: LayoutSnapshot | null = null;
  private nextTicket = 0;
  private intents = new Map<number, (accepted: LayoutSnapshot) => LayoutSnapshot>();
  private pendingCount = 0;
  private dropped = new Set<string>();
  private droppedSteps = new Set<string>();
  private named = new Map<string, string>();

  constructor(
    private readonly id: string,
    layout: LayoutRead,
    ports: LayoutSavePorts,
    private document = new WorkflowDocument(id),
  ) {
    this.base = layout;
    this.current = ports;
    this.document.layout ??= layout;
  }

  /** The latest document successfully read by the screen. */
  setLayout(layout: LayoutRead): void {
    if (!this.document.stale && this.pendingCount === 0 && (!this.document.revision || layout.editRevision === this.document.revision)) this.base = layout;
  }

  /** The screen's latest graph and callbacks. */
  setPorts(ports: LayoutSavePorts): void {
    this.current = ports;
  }

  private send = async (snapshot: LayoutSnapshot, ticket: number): Promise<void> => {
      if (this.document.stale || this.document.disposed) { this.current.onState({ kind: "stale" }); return; }
      const doc = this.document.layout ?? this.base;
      const steps: Record<string, { x: number; y: number }> = {};
      const sources: Record<string, { x: number; y: number }> = { ...doc.sources };
      for (const name of this.dropped) delete sources[name];
      // Every position given is written. A member the graph does not hold
      // yet still travels through the placement names retained below.
      const byId = new Map(this.current.graph.members.map((m) => [m.id, m]));
      for (const [id, p] of Object.entries(snapshot.positions)) {
        const m = byId.get(id);
        if (m?.kind === "source" || id.startsWith("src:")) {
          const name = m?.kind === "source" ? m.name : (this.named.get(id) ?? id.slice(4));
          if (this.dropped.has(name)) continue;
          sources[name] = { x: p.x, y: p.y };
        } else if (!id.startsWith("note:")) {
          if (this.droppedSteps.has(id)) continue;
          steps[id] = { x: p.x, y: p.y };
        }
      }
      this.current.onState({ kind: "saving" });
      try {
        let response: Response;
        try {
          response = await this.document.send(`/api/recipes/${this.id}/layout`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ steps, sources, notes: snapshot.notes }),
          });
        } catch {
          throw new Error(serverUnreachable("save the arrangement"));
        }
        if (!response.ok) throw new Error(await readApiError(response));
        this.base = ((await response.json()) as { layout: LayoutRead }).layout;
        for (const pending of this.intents.keys()) if (pending <= ticket) this.intents.delete(pending);
        for (const name of this.dropped) if (!(name in this.base.sources)) this.dropped.delete(name);
        for (const sid of this.droppedSteps) if (!(sid in this.base.steps)) this.droppedSteps.delete(sid);
        this.current.onWritten?.(this.base);
        if (this.pendingCount === 1) this.current.onState({ kind: "saved" });
      } catch (e) {
        if (this.document.stale) { this.current.onState({ kind: "stale" }); return; }
        this.current.onState({
          kind: "failed",
          message: e instanceof Error ? e.message : "Couldn’t save",
          retry: () => {
            const reason = this.current.lockReason();
            if (reason) {
              this.current.say(reason, "bad");
              return;
            }
            if (this.latest) this.write(this.latest);
          },
        });
      }
  };

  private snapshotOf(layout: LayoutRead): LayoutSnapshot {
    return { positions: { ...layout.steps, ...Object.fromEntries(Object.entries(layout.sources).map(([name, position]) => [`src:${name}`, position])) }, notes: layout.notes };
  }
  private write = (snapshot: LayoutSnapshot): void => {
    if (this.document.disposed) return;
    const before = this.latest ?? this.snapshotOf(this.base);
    const ticket = ++this.nextTicket;
    this.intents.set(ticket, fieldIntent(before, snapshot));
    this.latest = snapshot;
    this.document.draftLayout = snapshot;
    this.pendingCount++;
    void this.document.enqueue(async () => {
      let next = this.snapshotOf(this.document.layout ?? this.base);
      // Include unresolved predecessors; accepted changes have already
      // retired and must not overwrite the server's returned layout.
      for (const [pending, compose] of this.intents) if (pending <= ticket) next = compose(next);
      try { await this.send(next, ticket); }
      finally { this.pendingCount--; }
    });
  };

  save = (snapshot: LayoutSnapshot): void => this.write(snapshot);

  dropSource = (name: string, snapshot: LayoutSnapshot): void => {
    this.dropped.add(name);
    this.write(snapshot);
  };

  dropStep = (stepId: string, snapshot: LayoutSnapshot): void => {
    this.droppedSteps.add(stepId);
    this.write(snapshot);
  };

  placeSource = (sid: string, name: string, snapshot: LayoutSnapshot): void => {
    this.named.set(sid, name);
    this.write(snapshot);
  };

  restore = (snapshot: LayoutSnapshot, roads: { place: { id: string; name: string }[]; drop: string[] }): void => {
    for (const s of roads.place) {
      this.named.set(s.id, s.name);
      this.dropped.delete(s.name);
    }
    for (const name of roads.drop) this.dropped.add(name);
    this.write(snapshot);
  };

  pending = (): boolean => this.document.stale || this.pendingCount > 0;
}
