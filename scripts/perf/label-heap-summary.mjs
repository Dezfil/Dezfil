import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export function distribution(xs) {
  if (!xs.length || xs.some(x => !Number.isFinite(x))) throw new Error("Missing/nonfinite samples");
  const s = [...xs].sort((a, b) => a - b);
  const q = p => {
    const x = (s.length - 1) * p, i = Math.floor(x);
    return s[i] + (s[Math.ceil(x)] - s[i]) * (x - i);
  };
  return { min: s[0], p25: q(.25), median: q(.5), p75: q(.75), max: s.at(-1) };
}

export function validateFilterOrder(events, targetId, treatment) {
  const deletion = events.find(e => e.kind === "request" && e.method === "DELETE" && e.path === `/api/layers/${targetId}`);
  const filters = events.filter(e => e.kind === "response" && e.method === "PATCH" && e.path === `/api/layers/${targetId}` && e.filters && e.status >= 200 && e.status < 300);
  if (!deletion) return { valid: false, reason: "DELETE not observed" };
  if (treatment && !filters.some(e => e.ms < deletion.ms)) return { valid: false, reason: "settling filter PATCH not observed before DELETE" };
  if (!treatment && filters.length) return { valid: false, reason: "control received a filter build" };
  return { valid: true, reason: null };
}

export function pairValues(pair) {
  const { treatment: t, control: c } = pair.arms;
  const adjusted = (a, k) => a.heap[k].bytes - a.heap.beforeMount.bytes;
  const mountedCost = adjusted(t, "mounted");
  const excess = Object.fromEntries(["afterRemoval", "afterIdle", "afterStyle"].map(k => [k, adjusted(t, k) - adjusted(c, k)]));
  return { mountedCost, excess, pairedRatio: mountedCost > 0 ? excess.afterRemoval / mountedCost : null };
}

export function summarize(pairs) {
  const scales = [10000, 100000, 250000].map(scale => {
    const measured = pairs.filter(p => p.scale === scale && p.kind === "measurement");
    const warm = measured.filter(p => p.repetition > 0);
    const diagnostic = pairs.find(p => p.scale === scale && p.kind === "diagnostic");
    const errors = [];
    if (measured.filter(p => p.repetition === 0).length !== 1 || warm.length < 5 || new Set(warm.map(p => p.repetition)).size !== warm.length) errors.push("requires one cold and at least five distinct warm pairs");
    for (const p of measured) for (const arm of ["treatment", "control"])
      if (!p.arms[arm].guard.valid) errors.push(`${p.repetition} ${arm}: ${p.arms[arm].guard.reason}`);
    const d = diagnostic?.arms;
    if (!d?.treatment.retainer?.matches?.length) errors.push("treatment label-store retaining path not demonstrated");
    if (!d?.control.retainer || d.control.retainer.matches.length) errors.push("control contaminated or diagnostic unavailable");
    if (d) for (const arm of ["treatment", "control"]) {
      const a = d[arm];
      if (!a.guard.valid || !a.buildTrace?.length) errors.push(`${arm}: diagnostic order/build trace unavailable`);
      if (a.afterStyleRetainer?.matches?.length || !a.afterStyleRetainer) errors.push(`${arm}: store not demonstrably swept`);
    }
    if (!warm.length) return { scale, verdict: "inconclusive", errors };
    const values = warm.map(pairValues);
    if (values.some(p => p.pairedRatio === null)) errors.push("nonpositive mounted cost");
    const checkpoints = Object.fromEntries(["beforeMount", "mounted", "afterRemoval", "afterIdle", "afterStyle"].map(k => [k, {
      treatment: distribution(warm.map(p => p.arms.treatment.heap[k].bytes)),
      control: distribution(warm.map(p => p.arms.control.heap[k].bytes)),
    }]));
    const controlDrift = Object.fromEntries(["afterRemoval", "afterIdle", "afterStyle"].map(k => {
      const s = distribution(warm.map(p => p.arms.control.heap[k].bytes));
      return [k, s.max - s.min];
    }));
    const excess = Object.fromEntries(["afterRemoval", "afterIdle", "afterStyle"].map(k => [k, distribution(values.map(p => p.excess[k]))]));
    if (excess.afterStyle.median > controlDrift.afterStyle) errors.push("excess survives sweep outside control drift: attribution invalid");
    if (Math.abs(excess.afterRemoval.median) <= controlDrift.afterRemoval) errors.push("signal indistinguishable from control drift");
    const ratios = values.filter(v => v.pairedRatio !== null).map(v => v.pairedRatio);
    const ratio = ratios.length ? distribution(ratios) : null;
    return { scale, cold: measured.filter(p => p.repetition === 0).map(pairValues), warm: values,
      checkpoints, mountedCost: distribution(values.map(v => v.mountedCost)), controlDrift, excess, ratio,
      errors, verdict: errors.length ? "inconclusive" : ratio.median >= .5 ? "crossed" : "not crossed" };
  });
  const supported = scales.filter(s => s.scale !== 10000);
  return { row: "label-retained-heap", scales, boundVerdict: supported.some(s => s.verdict === "crossed") ? "crossed" : supported.every(s => s.verdict === "not crossed") ? "not crossed" : "inconclusive" };
}

function jsonFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? jsonFiles(join(dir, e.name)) : /^pair-.*\.json$/.test(e.name) ? [join(dir, e.name)] : []);
}
// Playwright imports this file through its CommonJS transform. Keep the CLI
// entry check compatible with that loader as well as direct Node execution.
if (process.argv[1] && basename(process.argv[1]) === "label-heap-summary.mjs") {
  const input = process.argv[2];
  const output = process.argv[process.argv.indexOf("--output") + 1];
  if (!input || !process.argv.includes("--output")) throw new Error("Usage: node scripts/perf/label-heap-summary.mjs RESULTS --output SUMMARY.json");
  const summary = summarize(jsonFiles(input).map(f => JSON.parse(readFileSync(f, "utf8"))));
  writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}
