// Profiling harness — server-side per-execution cost.
//
// Measurement only: it uploads, creates and reads through the documented API
// and prints timings. It writes nothing outside the instance's own data
// directory, and changes no product behavior.
//
// Re-run (production standalone, a FRESH data directory, never port 3000):
//
//   DEZFIL_DATA_DIR=$(mktemp -d) PORT=3141 HOSTNAME=127.0.0.1 \
//     DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 \
//     node .next/standalone/<project-path>/server.js &
//   node scripts/perf/api-cost.mjs http://127.0.0.1:3141
//
// The egress allowlist is REQUIRED: the refresh arm
// imports a table from a loopback fixture this harness serves itself, and
// refreshes it. Without the allowlist that arm dies with the server's
// egress refusal — provision it rather than skipping the arm.
//
// The harness REFUSES a non-empty registry: what it can verify is
// that `/api/tables` answers empty, so that is the check it makes; literal
// directory freshness stays the run recipe's responsibility. `--rows N`
// (default 100000) sizes the measured table, `--reps N` (default 15) the
// warm sample count, `--tables N` (default 40) the catalog ceiling —
// criterion runs use `--rows 100000 --reps 15 --tables 80`.
//
// What it measures, and why each number is the honest one:
//
//  * dock-grid execution — one `POST /api/query` with a
//    layer's own SQL, which is exactly what `SqlDock` sends when the grid
//    opens. `runtimeMs` in the response is the engine's three statements
//    (DESCRIBE + count(*) + LIMIT preview); the wall time also carries the
//    per-request catalog registration and the JSON serialization.
//  * widget-values batch — one `POST
//    /api/maps/{id}/widget-values`, the batch a widget edit used to
//    retrigger per keystroke.
//  * catalog registration — the per-request
//    tax `registerTableViews` adds, measured as `POST /api/query
//    {"sql":"SELECT 1"}` while the table count grows. `SELECT 1` touches
//    no table, so the whole wall time above the zero-table floor is
//    registration; the floor itself is the CONTROL arm — the number the
//    change must not move.
//  * concurrency — K simultaneous `SELECT 1` at BOTH 1 table and the top
//    count, so the table-count tax separates from plain concurrency
//    scaling (compares same-K across table counts).
//  * first evaluation after a mutation — the first
//    `SELECT 1` after an upload, after a refresh and after a delete,
//    each sampled across repeated mutations. This is exactly where an
//    incremental design would put deferred work, so it is reported
//    rather than discarded.
//
// Every timed request asserts the answer it claims to time — the expected
// row count, the expected scalar, the expected widget values — so an
// endpoint that got faster by doing less fails the run instead of
// flattering it.

import { createServer } from "node:http";

const base = process.argv[2] ?? "http://127.0.0.1:3141";
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const ROWS = arg("rows", 100_000);
const REPS = arg("reps", 15);
const TABLE_CEILING = arg("tables", 40);
/** Table counts at which the registration tax is sampled. */
const TABLE_STEPS = [1, 5, 10, 20, 40, 80].filter((n) => n <= TABLE_CEILING);
/** Mutations sampled per kind in the first-evaluation arms. */
const MUTATIONS = Math.min(REPS, 8);

async function api(method, pathname, { body, form } = {}) {
  const init = { method, headers: {} };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

function die(msg, detail) {
  console.error(`\n✗ ${msg}`);
  if (detail !== undefined) console.error(`  ${JSON.stringify(detail)}`);
  process.exit(1);
}

// ------------------------------------------------------------- assertions
//
// The answer checks each timed arm makes. A sample whose response fails
// its check is invalid and kills the run — an invalid sample silently
// kept would be a defect in the measurement.

/** `SELECT 1` must answer exactly one row holding the scalar 1. */
function assertScalarOne(r) {
  if (r.status !== 200) die("SELECT 1 failed", r.json);
  const preview = r.json?.preview;
  if (
    r.json?.rowCount !== 1 ||
    !Array.isArray(preview) ||
    preview.length !== 1 ||
    Number(Object.values(preview[0])[0]) !== 1
  ) {
    die("SELECT 1 answered wrong — not one row of scalar 1", r.json);
  }
  return r.json.runtimeMs;
}

/** A table query must report the row count the fixture actually holds. */
function assertRowCount(r, expected, label) {
  if (r.status !== 200) die(`${label} failed`, r.json);
  if (r.json?.rowCount !== expected) {
    die(
      `${label} answered wrong — rowCount ${r.json?.rowCount}, expected ${expected}`,
      r.json,
    );
  }
  return r.json.runtimeMs;
}

/** Sum of `i % 4000` over the fixture's rows — the formula widget's true
 * total, computed independently of the endpoint under measurement. */
function expectedRidersSum(rows) {
  let sum = 0;
  for (let i = 0; i < rows; i++) sum += i % 4000;
  return sum;
}
const RIDERS_SUM = expectedRidersSum(ROWS);

/** The widget-values batch must answer every widget with its real value —
 * the formula's independently computed sum, category counts and histogram
 * bins that sum to the row count — not merely a 200. */
function assertWidgetValues(r, expectedCount) {
  if (r.status !== 200) die("widget-values failed", r.json);
  const widgets = r.json?.widgets;
  if (!Array.isArray(widgets) || widgets.length !== expectedCount) {
    die(
      `widget-values answered wrong — ${widgets?.length ?? "no"} widgets, expected ${expectedCount}`,
      r.json,
    );
  }
  for (const w of widgets) {
    if (w.error) die(`widget ${w.id} errored`, w);
    if (w.type === "formula" && w.value !== RIDERS_SUM) {
      die(`formula answered ${w.value}, expected ${RIDERS_SUM}`, w);
    }
    if (w.type === "category") {
      const sum =
        w.categories.reduce((a, c) => a + c.n, 0) + (w.other ?? 0);
      if (sum !== ROWS) die(`category counts sum to ${sum}, expected ${ROWS}`, w);
    }
    if (w.type === "histogram") {
      const sum = w.bins.reduce((a, b) => a + b, 0);
      if (sum !== ROWS) die(`histogram bins sum to ${sum}, expected ${ROWS}`, w);
    }
  }
  if (expectedCount > 0) {
    const layers = r.json?.layers;
    if (!Array.isArray(layers) || !layers.some((l) => l.total === ROWS)) {
      die(`widget-values layer totals miss the fixture's ${ROWS}`, r.json);
    }
  }
  return widgets.length;
}

// ------------------------------------------------------------------ timing

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * One cold call (reported separately — it pays for instance creation,
 * extension loading and any first-touch parquet read), then `reps` warm ones.
 */
async function measure(reps, fn) {
  const t0 = performance.now();
  const first = await fn();
  const cold = performance.now() - t0;
  const samples = [];
  const extras = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    const out = await fn();
    samples.push(performance.now() - t);
    extras.push(out);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: reps,
    cold,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1],
    first,
    extras,
  };
}

const ms = (v) => v.toFixed(1).padStart(8);

function report(label, s, tail = "") {
  console.log(
    `  ${label.padEnd(40)} cold ${ms(s.cold)}  min ${ms(s.min)}  p25 ${ms(
      s.p25,
    )}  median ${ms(s.median)}  p75 ${ms(s.p75)}  max ${ms(s.max)}   ms  (n=${
      s.n
    })${tail}`,
  );
}

/** Every sample here IS a first call — one mutation, then one timed
 * evaluation — so there is no warm set and no separate cold column. */
function reportFirst(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(40)} min ${ms(sorted[0])}  median ${ms(
      quantile(sorted, 0.5),
    )}  max ${ms(sorted[sorted.length - 1])}   ms  (n=${samples.length} mutations)`,
  );
}

// ----------------------------------------------------------------- fixtures

/** A CSV of `rows` point records with the columns the widgets aggregate. */
function csv(rows, seed = 0) {
  const out = ["name,lon,lat,riders,category,elevation"];
  for (let i = 0; i < rows; i++) {
    const n = i + seed;
    out.push(
      `Station ${n},${(13.2 + ((n % 9973) * 1e-4)).toFixed(6)},${(
        52.4 +
        ((n % 9967) * 1e-4)
      ).toFixed(6)},${n % 4000},${["transit", "retail", "park", "school", "civic", "other"][n % 6]},${
        n % 1200
      }`,
    );
  }
  return out.join("\n");
}

async function upload(name, rows, seed = 0) {
  const form = new FormData();
  form.append("file", new Blob([csv(rows, seed)]), `${name}.csv`);
  const r = await api("POST", "/api/tables", { form });
  if (r.status !== 201) die(`upload ${name} failed`, r.json);
  return r.json.name;
}

/** The loopback fixture behind the refresh arm: one CSV whose row count
 * the harness sets before each refresh, so a refreshed table's answer is
 * checkable against what was actually served. */
function startFixtureServer() {
  const state = { rows: 40 };
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/csv" });
    res.end(csv(state.rows, 500_000));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/fixture.csv`,
        state,
        close: () => server.close(),
      });
    });
  });
}

// --------------------------------------------------------------------- main

/** K simultaneous `SELECT 1`, every response validated: a sample is the
 * wall time for all K, and a sample with any wrong answer is invalid.
 * Runs at both 1 table and the top count. */
async function concurrencySweep(tableCount) {
  console.log(
    `\nConcurrency — K simultaneous POST /api/query {"sql":"SELECT 1"} at ${tableCount} table(s)`,
  );
  for (const k of [1, 2, 4, 8]) {
    const s = await measure(Math.min(REPS, 10), async () => {
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: k }, () =>
          api("POST", "/api/query", { body: { sql: "SELECT 1" } }),
        ),
      );
      for (const r of results) assertScalarOne(r);
      return performance.now() - started;
    });
    report(`${String(k).padStart(2)} concurrent (wall time for all K)`, s);
  }
}

async function main() {
  const health = await api("GET", "/api/health");
  if (health.status !== 200) die("instance not reachable", health.json);
  console.log(`\nDezfil API cost harness → ${base}`);
  console.log(
    `rows=${ROWS}  warm reps=${REPS}  catalog steps=[${TABLE_STEPS.join(", ")}]`,
  );
  const before = await api("GET", "/api/tables");
  if (Array.isArray(before.json) && before.json.length > 0) {
    // What this verifies is that the REGISTRY is empty — a reused
    // directory whose registry answers empty is indistinguishable from a
    // new one here, so literal freshness stays the run recipe's job.
    die(
      `registry not empty — ${before.json.length} table(s) already present. ` +
        `The comparison protocol needs a fresh DEZFIL_DATA_DIR per arm; restart on one.`,
    );
  }

  // ---- the floor: what a query costs with an empty catalog. This is the
  //      CONTROL arm — registration has nothing to do at zero tables, so
  //      the change must leave this number alone.
  console.log(
    `\nCatalog registration floor — POST /api/query {"sql":"SELECT 1"} with 0 tables (control)`,
  );
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
      return assertScalarOne(r);
    });
    report(`  0 tables registered (floor)`, s);
  }

  // ---- the measured table, map and layer
  const t0 = performance.now();
  const table = await upload("perf_stations", ROWS);
  const ingestMs = performance.now() - t0;
  console.log(
    `\ningest: ${ROWS} rows → table "${table}" in ${ingestMs.toFixed(0)} ms (cold, one sample)`,
  );

  // ---- the 1-table baseline, taken while the catalog
  //      holds exactly the measured table — the later growth arm starts
  //      above 1 because the refresh fixture imports before it.
  console.log(
    `\nCatalog registration baseline — POST /api/query {"sql":"SELECT 1"} at exactly 1 table`,
  );
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
      return assertScalarOne(r);
    });
    report(`  1 table registered (criterion-1 baseline)`, s);
  }

  // ---- concurrency at exactly one registered table: the same-K baseline
  //      the top count is compared against.
  await concurrencySweep(1);

  const mapRes = await api("POST", "/api/maps", { body: { name: "API cost perf" } });
  if (mapRes.status !== 201) die("map not created", mapRes.json);
  const mapId = mapRes.json.id;

  const sql = `SELECT name, riders, category, elevation, geometry FROM ${table}`;
  const layerRes = await api("POST", `/api/maps/${mapId}/layers`, {
    body: { name: "Stations", sql },
  });
  if (layerRes.status !== 201) die("layer not created", layerRes.json);
  const layerId = layerRes.json.id;

  // ---- one dock-grid execution
  console.log(
    `\ndock-grid execution — POST /api/query with the layer's own SQL`,
  );
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", { body: { sql } });
      return assertRowCount(r, ROWS, "dock-grid query");
    });
    const engine = [...s.extras].sort((a, b) => a - b);
    report(`layer SQL over ${ROWS} rows`, s, "");
    console.log(
      `  ${"".padEnd(40)}engine-reported runtimeMs: median ${quantile(
        engine,
        0.5,
      ).toFixed(1)}  (cold ${s.first} ms) — the three statements only`,
    );
  }
  // Same shape with a narrow projection: how much of it is the payload.
  {
    const narrow = `SELECT name FROM ${table}`;
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", { body: { sql: narrow } });
      return assertRowCount(r, ROWS, "narrow query");
    });
    report(`one column, no geometry (${ROWS} rows)`, s);
  }
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", {
        body: { sql: `SELECT count(*) AS n FROM ${table}` },
      });
      if (r.status !== 200) die("count query failed", r.json);
      if (Number(r.json?.preview?.[0]?.n) !== ROWS) {
        die(`count answered ${r.json?.preview?.[0]?.n}, expected ${ROWS}`, r.json);
      }
      return r.json.runtimeMs;
    });
    report(`aggregate to one row (${ROWS} rows)`, s);
  }

  // ---- one render, for scale: what the canvas pays for the same layer
  {
    const s = await measure(Math.min(REPS, 8), async () => {
      const r = await api("GET", `/api/layers/${layerId}/render`);
      if (r.status !== 200 || r.json?.ok !== true) die("render failed", r.json);
      if (!(r.json.featureCount > 0)) die("render answered no features", r.json);
      return r.json.featureCount;
    });
    report(`(for scale) GET /api/layers/{id}/render`, s, ` features=${s.first}`);
  }

  // ---- the widget-values batch
  const widgets = [
    {
      id: "w-formula",
      type: "formula",
      layerId,
      title: "Total riders",
      field: "riders",
      agg: "sum",
      aggField: null,
      unit: null,
      note: null,
      format: null,
      visible: true,
    },
    {
      id: "w-category",
      type: "category",
      layerId,
      title: "By category",
      field: "category",
      agg: "count",
      aggField: null,
      unit: null,
      note: null,
      format: null,
      visible: true,
    },
    {
      id: "w-histogram",
      type: "histogram",
      layerId,
      title: "Riders",
      field: "riders",
      agg: "count",
      aggField: null,
      unit: null,
      note: null,
      format: null,
      visible: true,
    },
  ];
  const patched = await api("PATCH", `/api/maps/${mapId}`, {
    body: { widgets },
  });
  if (patched.status !== 200) die("widgets not saved", patched.json);

  console.log(
    `\nwidget-values batch — POST /api/maps/{id}/widget-values`,
  );
  // A ZERO-widget baseline first: without it, the
  // one-widget figure is the whole request — HTTP, routing, catalog
  // registration, layer counts, serialization — and cannot be compared
  // with the differences between adjacent batch sizes.
  {
    const saved = await api("PATCH", `/api/maps/${mapId}`, {
      body: { widgets: [] },
    });
    if (saved.status !== 200) die("empty widget set not saved", saved.json);
    const s = await measure(REPS, async () => {
      const r = await api("POST", `/api/maps/${mapId}/widget-values`, {
        body: {},
      });
      return assertWidgetValues(r, 0);
    });
    report(`0 widgets (request floor: HTTP + registration)`, s);
  }
  for (const count of [1, 2, 3]) {
    const subset = widgets.slice(0, count);
    const saved = await api("PATCH", `/api/maps/${mapId}`, {
      body: { widgets: subset },
    });
    if (saved.status !== 200) die("widget subset not saved", saved.json);
    const s = await measure(REPS, async () => {
      const r = await api("POST", `/api/maps/${mapId}/widget-values`, {
        body: {},
      });
      return assertWidgetValues(r, count);
    });
    report(
      `${count} widget(s) [${subset.map((w) => w.type).join("+")}] over ${ROWS} rows`,
      s,
    );
  }
  // With a draft widget, which is what the builder's open editor sends.
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", `/api/maps/${mapId}/widget-values`, {
        body: {
          draft: {
            ...widgets[2],
            id: "w-draft",
            title: "Draft histogram",
          },
        },
      });
      return assertWidgetValues(r, 4);
    });
    report(`3 stored + 1 draft (the open editor's request)`, s);
  }
  // Restore the full set for the record.
  await api("PATCH", `/api/maps/${mapId}`, { body: { widgets } });
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", `/api/maps/${mapId}/widget-values`, {
        body: {},
      });
      return assertWidgetValues(r, 3);
    });
    report(`3 widgets, restored set`, s);
  }

  // ---- the refreshable table, imported from this harness's own loopback
  //      fixture BEFORE the catalog grows, so the top step still lands on
  //      exactly the configured count. Needs the server booted with
  //      DEZFIL_EGRESS_ALLOWLIST=127.0.0.1 (see header).
  const fixture = await startFixtureServer();
  {
    const r = await api("POST", "/api/imports/url", {
      body: { url: fixture.url, name: "perf_url_refresh" },
    });
    if (r.status !== 201) {
      die(
        "loopback URL import failed — is the server booted with DEZFIL_EGRESS_ALLOWLIST=127.0.0.1?",
        r.json,
      );
    }
    const check = await api("POST", "/api/query", {
      body: { sql: `SELECT count(*) AS n FROM perf_url_refresh` },
    });
    if (Number(check.json?.preview?.[0]?.n) !== fixture.state.rows) {
      die("URL-imported table does not answer the served rows", check.json);
    }
  }

  // ---- catalog registration tax
  console.log(
    `\nCatalog registration — POST /api/query {"sql":"SELECT 1"} as the table count grows`,
  );
  let created = (await api("GET", "/api/tables")).json.length;
  for (const target of TABLE_STEPS) {
    while (created < target) {
      created += 1;
      // Small tables: the measurement is the per-view registration, not the
      // parquet size. Each is a distinct artifact with its own footer.
      await upload(`perf_cat_${created}`, 50, created * 1000);
    }
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
      return assertScalarOne(r);
    });
    report(`${String(created).padStart(3)} tables registered`, s);
  }

  // ---- the same tax on the paths a builder session actually walks
  console.log(
    `\nThe registration tax on real paths, now that ${created} tables are registered`,
  );
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", "/api/query", { body: { sql } });
      return assertRowCount(r, ROWS, "dock-grid query");
    });
    const engine = [...s.extras].sort((a, b) => a - b);
    report(`dock-grid execution again`, s);
    console.log(
      `  ${"".padEnd(40)}engine-reported runtimeMs: median ${quantile(
        engine,
        0.5,
      ).toFixed(1)} — unchanged by the catalog; the rest is registration`,
    );
  }
  {
    const s = await measure(Math.min(REPS, 8), async () => {
      const r = await api("GET", `/api/layers/${layerId}/render`);
      if (r.status !== 200 || r.json?.ok !== true) die("render failed", r.json);
      if (!(r.json.featureCount > 0)) die("render answered no features", r.json);
      return r.json.featureCount;
    });
    report(`GET /api/layers/{id}/render again`, s);
  }
  {
    const s = await measure(REPS, async () => {
      const r = await api("POST", `/api/maps/${mapId}/widget-values`, {
        body: {},
      });
      return assertWidgetValues(r, 3);
    });
    report(`widget-values (3 widgets) again`, s);
  }

  // ---- concurrency at the top count, matching the 1-table sweep above
  await concurrencySweep(created);

  // ---- first evaluation after a mutation: the warm
  //      medians above exclude each arm's first call, which is exactly
  //      where an incremental design would put deferred work — so the
  //      first call after each mutation kind is measured on its own.
  // The catalog is NOT fixed across these arms: uploads retain their
  // tables (so upload samples run at created+1 … created+MUTATIONS),
  // refreshes run at the resulting top count, and deletes walk it back
  // down. The labels carry the true ranges — replacing each table
  // between samples would contaminate the next sample with the prior
  // delete's own reconciliation.
  console.log(
    `\nFirst evaluation after a mutation, catalog ${created}–${
      created + MUTATIONS
    } tables across the arms — where deferred work would land`,
  );
  {
    const samples = [];
    for (let i = 1; i <= MUTATIONS; i++) {
      await upload(`perf_first_${i}`, 50, 900_000 + i * 1000);
      const t = performance.now();
      const r = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
      samples.push(performance.now() - t);
      assertScalarOne(r);
      // The uploaded table answers on its own first touch too, at the
      // API surface — untimed, so the timed sample stays SELECT 1.
      const check = await api("POST", "/api/query", {
        body: { sql: `SELECT count(*) AS n FROM perf_first_${i}` },
      });
      if (Number(check.json?.preview?.[0]?.n) !== 50) {
        die(`uploaded perf_first_${i} does not answer`, check.json);
      }
    }
    reportFirst(
      `after an upload (catalog ${created + 1}→${created + MUTATIONS})`,
      samples,
    );
  }
  {
    const samples = [];
    for (let i = 1; i <= MUTATIONS; i++) {
      fixture.state.rows = 40 + i;
      const r = await api("POST", "/api/tables/perf_url_refresh/refresh", {
        body: {},
      });
      if (r.status !== 200) die("refresh failed", r.json);
      const t = performance.now();
      const q = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
      samples.push(performance.now() - t);
      assertScalarOne(q);
      // The refreshed table must answer from its NEW artifact — the served
      // row count changed with this refresh, at the API
      // surface — untimed.
      const check = await api("POST", "/api/query", {
        body: { sql: `SELECT count(*) AS n FROM perf_url_refresh` },
      });
      if (Number(check.json?.preview?.[0]?.n) !== fixture.state.rows) {
        die(
          `refreshed table answers ${check.json?.preview?.[0]?.n} rows, served ${fixture.state.rows}`,
          check.json,
        );
      }
    }
    reportFirst(
      `after a refresh (at ${created + MUTATIONS} tables)`,
      samples,
    );
  }
  {
    // Delete differs from upload and refresh: its route AWAITS the
    // chained view drop, so the delete's own catalog work rides the
    // DELETE request — the evaluation after it is steady state, not
    // where deferred work could hide. Both are
    // timed so the arm says where the work actually landed.
    const deletes = [];
    const samples = [];
    for (let i = 1; i <= MUTATIONS; i++) {
      const td = performance.now();
      const r = await api("DELETE", `/api/tables/perf_first_${i}`);
      deletes.push(performance.now() - td);
      if (r.status !== 204) die(`delete perf_first_${i} failed`, r.json);
      const t = performance.now();
      const q = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
      samples.push(performance.now() - t);
      assertScalarOne(q);
      // The deleted table stops answering, at the API surface — untimed.
      const check = await api("POST", "/api/query", {
        body: { sql: `SELECT count(*) AS n FROM perf_first_${i}` },
      });
      if (check.status === 200) {
        die(`deleted perf_first_${i} still answers`, check.json);
      }
    }
    reportFirst(
      `the DELETE call (carries the chained drop)`,
      deletes,
    );
    reportFirst(
      `after a delete, steady state (${created + MUTATIONS - 1}→${created} tables)`,
      samples,
    );
  }
  fixture.close();

  // ---- does the ARTIFACT SIZE matter, or only the table count? Each
  //      registration re-binds `read_parquet(path)`, which reads the file's
  //      footer. `--fat N --fatRows M` adds N tables of M rows on a fresh
  //      instance so the per-table slope can be compared with the 50-row one.
  const FAT = arg("fat", 0);
  if (FAT > 0) {
    const FAT_ROWS = arg("fatRows", 100_000);
    console.log(
      `\nArtifact size — ${FAT} tables of ${FAT_ROWS} rows, same SELECT 1 probe`,
    );
    let fat = 0;
    for (const target of [1, 5, 10, 20].filter((n) => n <= FAT)) {
      while (fat < target) {
        fat += 1;
        await upload(`perf_fat_${fat}`, FAT_ROWS, fat * 1_000_000);
      }
      const s = await measure(REPS, async () => {
        const r = await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
        return assertScalarOne(r);
      });
      // Report the TOTAL registered count, not just the fat ones (review
      // round two): the catalog also holds this run's own measured table,
      // and comparing per-view cost across arms needs the real denominator.
      const total = (await api("GET", "/api/tables")).json.length;
      report(
        `${String(fat).padStart(3)} fat tables → ${total} views registered`,
        s,
      );
    }
  }

  console.log("");
}

main().catch((error) => die("harness crashed", String(error)));
