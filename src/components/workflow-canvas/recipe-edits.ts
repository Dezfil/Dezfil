/**
 * The recipe-edit lanes: every node has its own lane; one edit of a node is
 * on the wire at a time, and an edit made while one is in flight waits and
 * is sent when it lands, replacing any that waited before it. Lanes of
 * different nodes run side by side. A structural change to a node (its
 * removal) waits until its lane is idle. Pure, so the rule is testable
 * without a browser.
 */
export class EditLanes<T> {
  private lanes = new Map<string, { inFlight: boolean; pending: T | null; onIdle: (() => void)[] }>();

  private lane(id: string) {
    let l = this.lanes.get(id);
    if (!l) {
      l = { inFlight: false, pending: null, onIdle: [] };
      this.lanes.set(id, l);
    }
    return l;
  }

  /** Offer an edit for a node: what to send now, or null while one is in
   * flight (the edit waits, replacing any that waited). */
  offer(id: string, edit: T): { send: T | null; superseded: T | null } {
    const l = this.lane(id);
    if (l.inFlight) {
      const superseded = l.pending;
      l.pending = edit;
      return { send: null, superseded };
    }
    l.inFlight = true;
    return { send: edit, superseded: null };
  }

  /** An edit landed: the next to send for that node, or null when its lane
   * is idle again (and anyone waiting for idle is told). */
  landed(id: string): T | null {
    const l = this.lane(id);
    const next = l.pending;
    l.pending = null;
    if (next) return next;
    l.inFlight = false;
    const waiting = l.onIdle;
    l.onIdle = [];
    for (const w of waiting) w();
    return null;
  }

  busy(id: string): boolean {
    return this.lane(id).inFlight;
  }

  /** Resolves once the node's lane is idle — now, or when its edits land. */
  /** Every lane that has ever carried an edit. */
  ids(): string[] {
    return [...this.lanes.keys()];
  }

  whenIdle(id: string): Promise<void> {
    const l = this.lane(id);
    if (!l.inFlight) return Promise.resolve();
    return new Promise((resolve) => l.onIdle.push(resolve));
  }

  forget(id: string): void {
    this.lanes.delete(id);
  }
}
