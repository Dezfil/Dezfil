import type { LayerRenderData } from "./render-data";

export type Renders = Record<string, LayerRenderData>;

/**
 * The one ordering rule for a builder's render answers. A render request
 * takes a ticket as it is sent, and its answer is checked against the
 * ticket when it lands, so what a layer shows only ever moves forward,
 * whatever order the network delivers answers in:
 *
 * - Newer means sent later: a request sent after a write was accepted sees
 *   that write, one sent before may not, even if it lands after. An answer
 *   is dropped once an answer sent after it has been shown. An earlier
 *   answer that lands first is still shown until the later one arrives: it
 *   is newer than what it replaces, and dropping it would let a layer that
 *   answers slowly be overtaken by its next poll forever.
 * - A whole-map replacement (a load or reload, an applied undo or redo, the
 *   assistant's resync) asks again for every layer it lists, so it overtakes
 *   every request sent before it. A layer it does not list has left the map.
 *   A later replacement overtakes it in turn.
 * - A layer that left the map is dropped with its answers still in flight,
 *   and only a later replacement that lists it again brings it back.
 *
 * The class holds tickets only; the shown set stays with its owner, which
 * passes it in and installs what comes back.
 */
export class RenderOrder {
  private sent = 0;
  /** Per known layer, the oldest ticket whose answer may still be shown:
   * one past the answer it shows, the replacement that last listed it, or
   * never once it has left the map. */
  private readonly floor = new Map<string, number>();
  /** The newest replacement's ticket. */
  private replacedAt = 0;

  /** Ticket one layer's request as it is sent. */
  request(layerId: string): number {
    if (!this.floor.has(layerId)) this.floor.set(layerId, 0);
    return ++this.sent;
  }

  /** One layer's answer applied to the shown set, or null when it has been
   * overtaken by a later answer, a replacement or the layer's removal. */
  answer(
    shown: Renders,
    layerId: string,
    ticket: number,
    data: LayerRenderData,
  ): Renders | null {
    if (!this.applies(layerId, ticket)) return null;
    this.floor.set(layerId, ticket + 1);
    return { ...shown, [layerId]: data };
  }

  /** Begin a replacement that lists exactly these layers. Every request
   * sent before it is overtaken, and the shown set loses the layers it does
   * not list at once (the replaced map no longer has them). */
  replace(
    shown: Renders,
    layerIds: readonly string[],
  ): { ticket: number; shown: Renders } {
    const ticket = ++this.sent;
    this.replacedAt = ticket;
    const listed = new Set(layerIds);
    for (const id of [...this.floor.keys(), ...Object.keys(shown)]) {
      if (!listed.has(id)) this.floor.set(id, Infinity);
    }
    for (const id of listed) this.floor.set(id, ticket);
    return { ticket, shown: this.without(shown, (id) => !listed.has(id)) };
  }

  /** A replacement's answers applied to the shown set, or null when a later
   * replacement has overtaken it. A layer that has shown an answer sent
   * since, or has left the map since, keeps what it shows. */
  settle(shown: Renders, ticket: number, answers: Renders): Renders | null {
    if (ticket !== this.replacedAt) return null;
    const next = { ...shown };
    for (const [id, data] of Object.entries(answers)) {
      if (!this.applies(id, ticket)) continue;
      this.floor.set(id, ticket + 1);
      next[id] = data;
    }
    return next;
  }

  /** The layer left the map: the shown set without it. */
  remove(shown: Renders, layerId: string): Renders {
    this.floor.set(layerId, Infinity);
    return this.without(shown, (id) => id === layerId);
  }

  private applies(layerId: string, ticket: number): boolean {
    return ticket >= (this.floor.get(layerId) ?? 0);
  }

  private without(shown: Renders, drop: (id: string) => boolean): Renders {
    if (!Object.keys(shown).some(drop)) return shown;
    return Object.fromEntries(Object.entries(shown).filter(([id]) => !drop(id)));
  }
}
