/**
 * How the OpenStreetMap assembler joins a relation's member ways into
 * rings and lines, reproduced over the members' vertices so that a
 * preview can know which rings it keeps without building them.
 *
 * The last pending way opens a run. While the run is not closed (its two
 * ends naming the same node), the pending ways are searched in order for
 * one with an end that meets an end of the run, and the first found is
 * attached: at the run's last node or at its first, given up the node they
 * share, and reversed when it meets with the end it would otherwise lead
 * with. When none meets, or the run closes, the next pending way opens the
 * next run. Two ends meet only when both are present and name the same
 * node.
 */
export function joinRuns<V>(ways: readonly (readonly V[])[], key: (vertex: V) => string): V[][] {
  const meets = (a: V | undefined, b: V | undefined) => a !== undefined && b !== undefined && key(a) === key(b);
  const pending = ways.slice();
  const runs: V[][] = [];
  while (pending.length) {
    let run = pending.pop()!.slice();
    runs.push(run);
    while (pending.length && !meets(run[0], run[run.length - 1])) {
      const first = run[0];
      const last = run[run.length - 1];
      let found = -1;
      let attach: V[] = [];
      let atEnd = true;
      for (let i = 0; i < pending.length && found < 0; i++) {
        const way = pending[i];
        const head = way[0];
        const tail = way[way.length - 1];
        if (meets(last, head)) { found = i; attach = way.slice(1); }
        else if (meets(last, tail)) { found = i; attach = way.slice(0, -1).reverse(); }
        else if (meets(first, tail)) { found = i; attach = way.slice(0, -1); atEnd = false; }
        else if (meets(first, head)) { found = i; attach = way.slice(1).reverse(); atEnd = false; }
      }
      if (found < 0) break;
      pending.splice(found, 1);
      if (atEnd) {
        for (const vertex of attach) run.push(vertex);
      } else {
        run = attach.concat(run);
        runs[runs.length - 1] = run;
      }
    }
  }
  return runs;
}

/** A ring the assembler keeps has at least four nodes; a shorter one is
 * dropped from the feature. */
export const KEPT_RING = 4;
