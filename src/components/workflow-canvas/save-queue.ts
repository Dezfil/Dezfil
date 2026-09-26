/**
 * Serialized layout saves (the whole snapshot): whole-document writes must
 * land in the order they were made, and two on the wire at once cannot be
 * ordered by the client — the older can commit last. So at most one write
 * is in flight; a snapshot offered meanwhile waits, and only the newest of
 * them is sent when the flight lands. Pure, so the rule is testable
 * without a browser.
 */
export class SaveQueue<T> {
  private inFlight = false;
  private pending: T | null = null;

  /** Offer a snapshot: the one to send now, or null when a write is in
   * flight and this waits (replacing any that waited). */
  offer(snapshot: T): T | null {
    if (this.inFlight) {
      this.pending = snapshot;
      return null;
    }
    this.inFlight = true;
    return snapshot;
  }

  /** A write landed: the snapshot to send next (the flight continues),
   * or null when nothing waits (the flight ends). */
  landed(): T | null {
    const next = this.pending;
    this.pending = null;
    if (next) return next;
    this.inFlight = false;
    return null;
  }

  get busy(): boolean {
    return this.inFlight;
  }
}
