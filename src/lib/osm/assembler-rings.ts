/*
 * Adapted from osmtogeojson 3.0.0-beta.5 (index.js, `join`), which takes
 * it from the iD editor's relation.js. The osmtogeojson notice follows,
 * then iD's.
 *
 * Copyright (c) 2013 Martin Raifer
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * iD is licensed under the ISC License, its copyright held by the iD
 * contributors (https://github.com/openstreetmap/iD); its permission
 * notice follows.
 *
 * Permission to use, copy, modify, and/or distribute this software for
 * any purpose with or without fee is hereby granted, provided that the
 * above copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR
 * BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
 * OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
 * WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
 * SOFTWARE.
 */

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
export function joinRuns<V>(ways: readonly (readonly V[])[], key: (vertex: V) => string | number): V[][] {
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
