import { readFileSync } from "node:fs";

/** V8 snapshot graph, inspected offline: no remote handles hold the measured data.
 * Follow strong edges only. Match the actual LabelBase shape, not UUID strings
 * elsewhere in React state, and require key.type === FeatureCollection.
 */
export function inspectLabelRetainer(file, layerId) {
  const heap = JSON.parse(readFileSync(file, "utf8"));
  const { nodes, edges, strings } = heap;
  const m = heap.snapshot.meta;
  const nf = m.node_fields.length, ef = m.edge_fields.length;
  const ni = Object.fromEntries(m.node_fields.map((n, i) => [n, i]));
  const ei = Object.fromEntries(m.edge_fields.map((n, i) => [n, i]));
  const count = nodes.length / nf;
  const starts = new Uint32Array(count + 1);
  for (let n = 0; n < count; n++) starts[n + 1] = starts[n] + nodes[n * nf + ni.edge_count] * ef;
  const edgeType = e => m.edge_types[ei.type][edges[e + ei.type]];
  const edgeName = e => ["element", "hidden"].includes(edgeType(e))
    ? String(edges[e + ei.name_or_index]) : strings[edges[e + ei.name_or_index]];
  const target = e => edges[e + ei.to_node] / nf;
  const nodeName = n => strings[nodes[n * nf + ni.name]];
  const nodeId = n => String(nodes[n * nf + ni.id]);
  const prop = (n, name) => {
    for (let e = starts[n]; e < starts[n + 1]; e += ef)
      if (edgeType(e) === "property" && edgeName(e) === name) return target(e);
    return -1;
  };
  const candidates = [];
  for (let n = 0; n < count; n++) {
    const entry = prop(n, layerId);
    if (entry < 0 || prop(entry, "features") < 0 || prop(entry, "shape") < 0) continue;
    const fc = prop(entry, "key");
    if (fc < 0) continue;
    const type = prop(fc, "type");
    if (type < 0 || nodeName(type) !== "FeatureCollection") continue;
    candidates.push({ bases: n, entry, fc });
  }
  // Single BFS from V8's synthetic root supplies independently rooted paths.
  const parent = new Int32Array(count).fill(-1);
  const parentEdge = new Int32Array(count).fill(-1);
  const queue = new Uint32Array(count);
  let head = 0, tail = 1;
  queue[0] = 0; parent[0] = 0;
  while (head < tail) {
    const n = queue[head++];
    for (let e = starts[n]; e < starts[n + 1]; e += ef) {
      if (edgeType(e) === "weak") continue;
      const to = target(e);
      if (parent[to] !== -1) continue;
      parent[to] = n; parentEdge[to] = e; queue[tail++] = to;
    }
  }
  const pathTo = n => {
    if (parent[n] < 0) return null;
    const path = [];
    while (n !== 0) {
      path.push({ node: nodeName(n), id: nodeId(n), edge: edgeName(parentEdge[n]), edgeType: edgeType(parentEdge[n]) });
      n = parent[n];
    }
    return path.reverse();
  };
  const matches = candidates.filter(c => parent[c.bases] >= 0).map(c => ({
    basesId: nodeId(c.bases), entryId: nodeId(c.entry), featureCollectionId: nodeId(c.fc),
    path: [...pathTo(c.bases),
      { edge: layerId, node: nodeName(c.entry), id: nodeId(c.entry), edgeType: "property" },
      { edge: "key", node: nodeName(c.fc), id: nodeId(c.fc), edgeType: "property" }],
  }));
  // Diagnostic-only instrumentation can find the owning read/sweep object by
  // its closure context's direct reference to the matched bases object.
  const baseNodes = new Set(candidates.map(c => c.bases));
  const contexts = new Set();
  for (let n = 0; n < count; n++) {
    if (!nodeName(n).includes("Context")) continue;
    for (let e = starts[n]; e < starts[n + 1]; e += ef)
      if (edgeType(e) === "context" && baseNodes.has(target(e))) contexts.add(n);
  }
  const stores = [];
  for (let n = 0; n < count; n++) {
    const read = prop(n, "read"), sweep = prop(n, "sweep");
    if (read < 0 || sweep < 0) continue;
    for (let e = starts[read]; e < starts[read + 1]; e += ef) {
      if (edgeType(e) === "internal" && edgeName(e) === "context" && contexts.has(target(e))) {
        stores.push(nodeId(n)); break;
      }
    }
  }
  return { file, layerId, nodeCount: count, matches, storeIds: stores };
}
