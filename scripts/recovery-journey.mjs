// Run recovery across a real process boundary.
//
// The unit tests drive `register()` over durable rows, which proves recovery is
// wired into the startup hook — unhooking it turns four of them red. What they
// cannot prove is that a *restarted server* settles runs its predecessor left in
// flight, before anything can read them, because they never leave the test
// process. This does exactly that: it starts a server, gets a run genuinely
// executing, kills the process outright, starts a new one on the same data
// directory, and asks the API what became of the run.
//
// Re-run (needs `npm run build` first; never port 3000 — that is the dev server):
//
//   node scripts/recovery-journey.mjs
//   node scripts/recovery-journey.mjs --port 3199
//
// SIGKILL is deliberate: a graceful stop would let anything with a shutdown
// hook tidy up, and the case being verified is the one where nothing got to.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { provisionJourney } from "./journey-auth.mjs";
import { assertEvidenceWorktree } from "./dezfil-plugin-safety.mjs";
import path from "node:path";

assertEvidenceWorktree(process.cwd());
let authenticatedFetch;
const args = process.argv.slice(2);
const PORT = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 3197;
if (!Number.isInteger(PORT) || PORT === 3000 || PORT < 1024 || PORT > 65535) throw new Error("Use an isolated port");
const BASE = `http://127.0.0.1:${PORT}`;

// Minutes of engine work: certain to still be running when the server is killed.
const ENDLESS =
  "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

let failures = 0;
const ok = (label) => console.log(`  [32m✓[0m ${label}`);
const bad = (label, detail) => {
  failures += 1;
  console.log(`  [31m✗[0m ${label}`);
  if (detail) console.log(`     ${detail}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, route, body) {
  const response = await authenticatedFetch(`${BASE}${route}`, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* some routes answer no body */
  }
  return { status: response.status, json };
}

function startServer(dataDir) {
  // Detached, so the whole process group can be killed. `npx` spawns the real
  // server as a grandchild: killing the wrapper alone leaves that grandchild
  // holding the port, and the "replacement" server then fails to bind while
  // the health check happily answers from the process that never died. That
  // produced a false failure once already — the harness looked like a product
  // defect until the bind error surfaced.
  const child = spawn(process.execPath, ["--import=./scripts/ingress-preload.mjs", "./node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    // Two slots, because this harness needs two things executing at once: the
    // standalone run and the recipe run's first member. At the default of one
    // the second would sit queued, and killing a queued run verifies something
    // weaker than either criterion asks for.
    env: { ...process.env, DEZFIL_DATA_DIR: dataDir, DEZFIL_OPERATION_CONCURRENCY: "2" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.on("data", (d) => process.stdout.write(`    [server] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`    [server] ${d}`));
  return child;
}

/** Kill the server and everything it spawned, then wait for the port to free. */
async function killServer(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true; // nothing answering: the port is genuinely free
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

async function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

const dataDir = await mkdtemp(path.join(process.cwd(), ".claude/recovery-"));
console.log(`Dezfil recovery journey → ${BASE}\n  data directory: ${dataDir}`);

let server = startServer(dataDir);
try {
  if (!(await waitForHealth())) {
    bad("the first server never became ready");
    process.exit(1);
  }
  ok("first server up");
  authenticatedFetch = (await provisionJourney(BASE)).fetch;

  // A table to read, so the run has real work to do.
  const csv = "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n";
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "recovery_stations.csv");
  const upload = await authenticatedFetch(`${BASE}/api/tables`, { method: "POST", body: form });
  if (!upload.ok) {
    bad("could not seed a table", String(upload.status));
    process.exit(1);
  }
  const table = await upload.json();
  ok(`seeded table "${table.name}"`);

  // A recipe alongside it, so the same kill also crosses the cascade's own
  // reconciliation. A cascade's drive loop is
  // in-process exactly as the lane is, and unlike a job nothing else would
  // ever settle it — an unreconciled one reads watchably active forever.
  let cascadeId = null;
  let recipeId = null;
  {
    const recipe = await api("POST", "/api/recipes", { name: "Recovery recipe" });
    if (recipe.status !== 201) {
      bad("could not create a recipe", JSON.stringify(recipe.json));
    } else {
      recipeId = recipe.json.recipe.id;
      const slow = await api("POST", `/api/recipes/${recipeId}/steps`, {
        operation: "sql_step",
        parameters: { sql: ENDLESS, name: "interrupted_cascade_output" },
      });
      // A second step, so the cascade also has a member that never starts.
      await api("POST", `/api/recipes/${recipeId}/steps`, {
        operation: "sql_step",
        parameters: {
          sql: "SELECT count(*) AS n FROM interrupted_cascade_output",
          name: "interrupted_cascade_downstream",
        },
      });
      if (slow.status !== 201) {
        bad("could not add a recipe step", JSON.stringify(slow.json));
      } else {
        const run = await api("POST", `/api/recipes/${recipeId}/runs`, {});
        if (run.status !== 202) bad("recipe run was not accepted", JSON.stringify(run.json));
        else {
          cascadeId = run.json.run.id;
          ok(`recipe run ${cascadeId.slice(0, 8)}… accepted`);
        }
      }
    }
  }

  const started = await api("POST", "/api/operations/run", {
    operation: "sql_step",
    parameters: { sql: ENDLESS, name: "interrupted_output" },
  });
  if (started.status !== 202) {
    bad("run was not accepted", JSON.stringify(started.json));
    process.exit(1);
  }
  const runId = started.json.run.id;
  ok(`run ${runId.slice(0, 8)}… accepted`);

  // Wait until it is genuinely executing. Killing a queued run would verify
  // something weaker than the criterion asks for.
  let observed = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const polled = await api("GET", `/api/operations/runs/${runId}`);
    observed = polled.json?.run?.state;
    if (observed === "running") break;
    await sleep(200);
  }
  if (observed !== "running") {
    bad("the run never reached running before the kill", String(observed));
    process.exit(1);
  }
  ok("run observed executing");

  // SIGKILL the whole group: no shutdown hook, no chance to tidy up.
  if (!(await killServer(server))) {
    bad("the first server would not die; the rest would prove nothing");
    process.exit(1);
  }
  ok("server killed outright while the run was executing, and the port is free");

  server = startServer(dataDir);
  if (!(await waitForHealth())) {
    bad("the replacement server never became ready");
    process.exit(1);
  }
  ok("replacement server up on the same data directory");

  const after = await api("GET", `/api/operations/runs/${runId}`);
  const run = after.json?.run;
  if (after.status !== 200 || !run) {
    bad("the run could not be read after the restart", JSON.stringify(after.json));
  } else {
    if (run.state === "failed") ok("the interrupted run is terminal, and failed");
    else bad("the interrupted run did not settle", `state=${run.state}`);

    if (run.error?.code === "operation_interrupted")
      ok("it carries operation_interrupted");
    else bad("wrong coded reason", JSON.stringify(run.error));

    if (/while this run was executing/i.test(run.error?.message ?? ""))
      ok("and a reason true of a run that was executing");
    else bad("the reason does not describe an executing run", run.error?.message);
  }

  // Nothing was re-executed, and nothing half-published survived.
  const tables = await api("GET", "/api/tables");
  const leaked = (tables.json ?? []).find((t) => t.name === "interrupted_output");
  if (leaked) bad("the interrupted run left a dataset behind", leaked.name);
  else ok("no dataset from the interrupted run");

  await sleep(2_000);
  const again = await api("GET", `/api/operations/runs/${runId}`);
  if (again.json?.run?.state === "failed") ok("and it was not re-executed");
  else bad("the run changed state after recovery", again.json?.run?.state);

  // The cascade arm: a recipe run always reaches a terminal outcome.
  if (cascadeId && recipeId) {
    const cascade = await api("GET", `/api/recipes/${recipeId}/runs/${cascadeId}`);
    const run = cascade.json?.run;
    if (cascade.status !== 200 || !run) {
      bad("the recipe run could not be read after the restart", JSON.stringify(cascade.json));
    } else {
      if (run.outcome === "interrupted")
        ok("the interrupted recipe run settled 'interrupted', not left active");
      else bad("the recipe run did not settle", `outcome=${run.outcome}`);

      // Its members describe what actually happened, and none was resumed.
      const states = (run.members ?? []).map((m) => m.state);
      if (states.includes("failed") && states.includes("not_run"))
        ok("its members record what was running and what never started");
      else bad("the recipe run's members were not reconciled", states.join(","));

      const leftovers = (tables.json ?? []).filter((t) =>
        String(t.name).startsWith("interrupted_cascade"),
      );
      if (leftovers.length === 0) ok("and it published nothing");
      else bad("the interrupted recipe run left a dataset behind", leftovers.map((t) => t.name).join(","));
    }
  }
} finally {
  await killServer(server);
  await rm(dataDir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\n[32mrecovery journey passed[0m"
    : `\n[31m${failures} check(s) failed[0m`,
);
process.exit(failures === 0 ? 0 : 1);
