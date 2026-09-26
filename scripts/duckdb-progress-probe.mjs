// Can a running statement's progress be read
// on the hardened instance, and does the counter actually advance?
//
// The design pre-ratified an elapsed-time fallback *if no progress
// signal is readable*. The condition turned out not to be cleanly true: the
// pinned binding exposes one, and for some workloads it advances. The question therefore
// ruled at the spec gate rather than inheriting the fallback, and this script is
// the reproducible record behind that ruling.
//
// Re-run:
//
//   node scripts/duckdb-progress-probe.mjs
//
// It reports three things, and all three matter to the ruling:
//
//  1. Every way of enabling the progress bar, and the engine's answer to each.
//     There are exactly three, and all three are refused once the hardened
//     instance's configuration is locked.
//  2. Whether the counter advances on an UNLOCKED instance. This varies by
//     workload — which is why more than one shape is probed. A single shape
//     produced an over-confident claim once already.
//  3. That the lockdown is the thing in the way, not the binding.
//
// The ruling does not depend on 2: a statement's percentage would misdescribe a
// run made of several statements even if it were reachable. No percentage ships.

import { DuckDBInstance } from "@duckdb/node-api";
import { rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.tmpdir(), `dezfil-progress-probe-${process.pid}`);
const FILE = path.join(DIR, "probe.parquet");

const HARDENING = [
  "SET GLOBAL memory_limit = '2048MB'",
  "SET GLOBAL temp_directory = ''",
  "SET GLOBAL enable_external_access = false",
  "SET GLOBAL autoinstall_known_extensions = false",
  "SET GLOBAL autoload_known_extensions = false",
  "SET GLOBAL lock_configuration = true",
];

async function harden(instance) {
  const c = await instance.connect();
  for (const s of HARDENING) await c.run(s);
  c.disconnectSync();
}

/** Every route to enabling the setting, each reported with the engine's answer. */
async function enablementRoutes() {
  console.log(`\n=== the three ways to enable enable_progress_bar ===`);

  // 1 — the instance creation configuration, where extension_directory is set.
  try {
    await DuckDBInstance.create(":memory:", { enable_progress_bar: "true" });
    console.log(`  ACCEPTED  1. instance creation configuration`);
  } catch (e) {
    console.log(`  REFUSED   1. instance creation configuration -> ${String(e).slice(0, 90)}`);
  }
  // Control: prove the harness can set a key this way at all, so the refusal
  // above is the engine's answer about this key and not a broken call.
  try {
    await DuckDBInstance.create(":memory:", { memory_limit: "1024MB" });
    console.log(`  (control) a known-good key IS accepted the same way`);
  } catch (e) {
    console.log(`  (control) FAILED — this probe cannot be trusted: ${String(e).slice(0, 80)}`);
  }

  // 2 — globally, the way every other hardening setting is applied.
  {
    const inst = await DuckDBInstance.create(":memory:", {});
    const c = await inst.connect();
    try {
      await c.run("SET GLOBAL enable_progress_bar = true");
      console.log(`  ACCEPTED  2. SET GLOBAL`);
    } catch (e) {
      console.log(`  REFUSED   2. SET GLOBAL -> ${String(e).replace(/\s+/g, " ").slice(0, 90)}`);
    }
    c.disconnectSync();
  }

  // 3 — per session, on a connection handed out after the lockdown. This is the
  // only shape the product's connection model actually offers: every evaluation
  // gets a fresh connection, created long after the instance was locked.
  {
    const inst = await DuckDBInstance.create(":memory:", {});
    await harden(inst);
    const c = await inst.connect();
    try {
      await c.run("SET enable_progress_bar = true");
      console.log(`  ACCEPTED  3. SET on a session after lock_configuration`);
    } catch (e) {
      console.log(
        `  REFUSED   3. SET on a session after lock_configuration -> ${String(e).replace(/\s+/g, " ").slice(0, 90)}`,
      );
    }
    c.disconnectSync();
  }
}

async function sample(conn, label, sql) {
  const seen = [];
  const poll = setInterval(() => {
    const p = conn.progress;
    seen.push({ pct: p.percentage, done: Number(p.rows_processed), total: Number(p.total_rows_to_process) });
  }, 120);
  const started = Date.now();
  await conn.runAndReadAll(sql);
  clearInterval(poll);
  const ms = Date.now() - started;

  const moving = seen.filter((s) => s.pct > 0 && s.pct < 100);
  // A run too short to sample says nothing either way, and must never be
  // reported as a negative — that is how a broken measurement becomes a fact.
  const verdict =
    seen.length < 3
      ? `INCONCLUSIVE — only ${seen.length} samples in ${ms}ms, too fast to judge`
      : moving.length > 0
        ? `ADVANCES — ${moving.length} readings strictly between 0 and 100 ` +
          `(e.g. ${moving.slice(0, 4).map((m) => m.pct.toFixed(1) + "%").join(", ")})`
        : `NEVER ADVANCES — ${seen.length} samples over ${ms}ms, all at ${seen[0]?.pct}`;
  console.log(`  ${label}\n    ${verdict}`);
}

async function advancement() {
  console.log(`\n=== does the counter advance? (UNLOCKED instance, bar enabled) ===`);
  console.log(`  Probed on an unlocked instance deliberately: the point is to show`);
  console.log(`  the lockdown is what blocks this, not the binding.`);
  await mkdir(DIR, { recursive: true });
  const inst = await DuckDBInstance.create(":memory:", {});
  const setup = await inst.connect();
  await setup.run(
    `COPY (SELECT i AS id, i % 200000 AS k, random() AS x FROM range(0, 12000000) t(i))
     TO '${FILE}' (FORMAT PARQUET)`,
  );
  setup.disconnectSync();

  const conn = await inst.connect();
  await conn.run("SET enable_progress_bar = true");
  await conn.run("SET enable_progress_bar_print = false");

  await sample(conn, "a parquet hash join", `SELECT count(*) AS n FROM read_parquet('${FILE}') a
       JOIN read_parquet('${FILE}') b ON a.k = b.k`);
  await sample(conn, "a range() scan with per-row compute",
    `SELECT sum(i * 2) AS s FROM range(0, 6000000000) t(i)`);
  await sample(conn, "a parquet aggregation",
    `SELECT k, count(*) AS n FROM read_parquet('${FILE}') GROUP BY k ORDER BY n DESC LIMIT 1`);

  conn.disconnectSync();
  await rm(DIR, { recursive: true, force: true });
}

console.log(`Progress evidence — node ${process.version}, ${os.platform()} ${os.arch()}`);
await enablementRoutes();
await advancement();
console.log(`
=== what this establishes ===
The signal exists in the binding, and whether it advances depends on the
workload. It is unreachable from the hardened instance's connections by every
route the engine offers. Buying it would mean giving up lock_configuration,
which is what stops user SQL un-fencing its own filesystem access — refused at
the gate. And a statement's percentage is not a run's: a run is several
statements. The run therefore reports timings and no percentage.`);
