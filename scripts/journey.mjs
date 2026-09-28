// Headless journey: drive the whole product through the documented API, no
// browser (spec: the surface is agent-operable before). Run against a
// live instance: node scripts/journey.mjs http://localhost:3000
// Exits non-zero on the first broken step.

import { startLoopbackBasemap, assertBasemapTraffic } from "./loopback-basemap.mjs";
import { decodePng, countColored } from "./png-probe.mjs";
import { provisionJourney } from "./journey-auth.mjs";
import { journeyApi } from "./journey-http.mjs";

const base = process.argv[2] ?? "http://localhost:3000";

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${String(step).padStart(2, "0")} ${msg}`);
}
function fail(msg, detail) {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.error(`     ${detail}`);
  process.exit(1);
}

const anonymous = journeyApi(base);
let protectedApi;
const api = (method, pathname, options) =>
  (pathname.startsWith("/api/published/") || pathname === "/api/health" ? anonymous : protectedApi)(method, pathname, options);

async function main() {
  console.log(`\nDezfil headless journey → ${base}\n`);

  // 1. readiness
  {
    const r = await api("GET", "/api/health");
    if (r.status !== 200 || r.json?.status !== "ready")
      fail("instance not ready", JSON.stringify(r.json));
    ok("instance reports ready");
  }

  const credentials = await provisionJourney(base);
  protectedApi = journeyApi(base, { token: credentials.token });
  ok("signed in and created an API token before protected work");

  // 1b. the machine-readable API description is served
  {
    const r = await api("GET", "/api/openapi.json");
    if (r.status !== 200 || r.json?.openapi !== "3.1.0" || !r.json?.paths)
      fail("openapi description not served", JSON.stringify(r.status));
    ok("machine-readable API description is served");
  }

  // 2. upload a CSV with recognized coordinates
  const csv = [
    "name,lon,lat,riders",
    "alexanderplatz,13.41,52.52,900",
    "zoo,13.33,52.51,500",
    "sudkreuz,13.36,52.48,120",
  ].join("\n");
  let tableName;
  {
    const form = new FormData();
    form.append("file", new Blob([csv]), "journey_stations.csv");
    const r = await api("POST", "/api/tables", { form });
    if (r.status !== 201 || r.json?.geometryType !== "POINT")
      fail("upload did not produce a spatial table", JSON.stringify(r.json));
    tableName = r.json.name;
    ok(`uploaded → table "${tableName}" (${r.json.rowCount} rows, points)`);
  }

  // 3. unsupported format is refused
  {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "notes.txt");
    const r = await api("POST", "/api/tables", { form });
    if (r.status !== 415 || r.json?.error?.code !== "unsupported_format")
      fail("unsupported format was not refused", JSON.stringify(r.json));
    ok("unsupported format refused with documented code");
  }

  // 4. inspect the table
  {
    const r = await api("GET", `/api/tables/${tableName}`);
    if (r.status !== 200 || !Array.isArray(r.json?.preview))
      fail("inspect failed", JSON.stringify(r.json));
    ok("inspected table schema and preview");
  }

  // 5. run read-only SQL
  {
    const r = await api("POST", "/api/query", {
      body: { sql: `SELECT name, riders, geometry FROM ${tableName}` },
    });
    if (r.status !== 200 || r.json?.rowCount !== 3)
      fail("query did not return the expected rows", JSON.stringify(r.json));
    ok("ran spatial SQL, got 3 rows with exact total");
  }

  // 5b. an operation turns a query result into a durable dataset
  {
    // Discovered, not hard-coded: an agent reads the catalog and calls the
    // run endpoint with the parameters that catalog advertises.
    const cat = await api("GET", "/api/operations");
    const sqlStep = cat.json?.operations?.find((o) => o.id === "sql_step");
    if (cat.status !== 200 || !sqlStep)
      fail("operation catalog did not describe sql_step", JSON.stringify(cat.json));
    const advertised = sqlStep.parameters.map((p) => p.name).sort();
    if (advertised.join(",") !== "name,sql")
      fail("sql_step advertised unexpected parameters", advertised.join(","));

    // A geometryless result: the case that had no terminal action at all
    // before this spec, and the one a layer-shaped path refuses.
    // Derived from the uploaded table's registered name, which the registry
    // makes unique per run — a fixed name would pass once and then meet its
    // own refusal on a second run against the same instance.
    const derivedName = `${tableName}_count`;

    /** Poll a run to a terminal state, the way any client must. */
    const settle = async (runId, what) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const polled = await api("GET", `/api/operations/runs/${runId}`);
        if (polled.status !== 200)
          fail(`${what}: run could not be read`, JSON.stringify(polled.json));
        const state = polled.json?.run?.state;
        if (["succeeded", "failed", "cancelled"].includes(state)) return polled.json.run;
        if (Date.now() > deadline) fail(`${what}: run never settled`, state);
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    const run = await api("POST", "/api/operations/run", {
      body: {
        operation: "sql_step",
        parameters: {
          sql: `SELECT count(*) AS n FROM ${tableName}`,
          name: derivedName,
        },
      },
    });
    // Accepted, not completed: the API answers before the work is done.
    if (run.status !== 202)
      fail("operation run was not accepted asynchronously", JSON.stringify(run.json));
    if (!run.json?.run?.id || ["succeeded", "failed"].includes(run.json.run.state))
      fail("run answer was not a non-terminal run", JSON.stringify(run.json));
    if (run.json.run.output)
      fail("an accepted run already claimed an output", JSON.stringify(run.json.run));
    const settled = await settle(run.json.run.id, "first run");
    if (settled.state !== "succeeded" || !settled.output?.id)
      fail("operation run did not create a dataset", JSON.stringify(settled));

    // A constant identifier satisfies "is truthy", so uniqueness is compared
    // across two successful runs rather than asserted of one.
    const second = await api("POST", "/api/operations/run", {
      body: {
        operation: "sql_step",
        parameters: { sql: `SELECT 1 AS n`, name: `${derivedName}_two` },
      },
    });
    if (second.status !== 202) fail("second run was not accepted", JSON.stringify(second.json));
    const secondSettled = await settle(second.json.run.id, "second run");
    if (secondSettled.state !== "succeeded") fail("second run did not create", JSON.stringify(secondSettled));
    if (secondSettled.id === settled.id)
      fail("two runs shared one run identity", secondSettled.id);
    if (secondSettled.output.id === settled.output.id)
      fail("two runs shared one output identity", secondSettled.output.id);

    // A settled run names an output that is registered and queryable.
    const back = await api("POST", "/api/query", {
      body: { sql: `SELECT n FROM ${derivedName}` },
    });
    if (back.status !== 200 || Number(back.json?.preview?.[0]?.n) !== 3)
      fail("derived dataset not queryable after the run settled", JSON.stringify(back.json));

    // History answers for a subject, and keeps a success a later failure
    // cannot erase.
    const subject = `journey-${derivedName}`;
    const good = await api("POST", "/api/operations/run", {
      body: {
        operation: "sql_step",
        parameters: { sql: "SELECT 1 AS n", name: `${derivedName}_hist` },
        subject,
      },
    });
    if (good.status !== 202) fail("subject run was not accepted", JSON.stringify(good.json));
    await settle(good.json.run.id, "subject success");
    const bad = await api("POST", "/api/operations/run", {
      body: {
        operation: "sql_step",
        parameters: { sql: `SELECT no_such_column FROM ${tableName}`, name: `${derivedName}_hist2` },
        subject,
      },
    });
    // A binder error is accepted and reported on the run, not refused up front.
    if (bad.status !== 202)
      fail("a run that fails at execution was refused at admission", JSON.stringify(bad.json));
    const badSettled = await settle(bad.json.run.id, "subject failure");
    if (badSettled.state !== "failed" || badSettled.error?.code !== "sql_error")
      fail("an unbindable query did not fail as sql_error", JSON.stringify(badSettled));
    const history = await api("GET", `/api/operations/runs?subject=${encodeURIComponent(subject)}`);
    if (history.status !== 200 || history.json?.runs?.length !== 2)
      fail("subject history did not keep both runs", JSON.stringify(history.json));
    if (!history.json.runs.some((r) => r.state === "succeeded"))
      fail("a failed run erased the last success", JSON.stringify(history.json.runs));
    // No run reports a percentage it cannot measure.
    if (history.json.runs.some((r) => JSON.stringify(r).toLowerCase().includes("percent")))
      fail("a run reported a completion percentage", JSON.stringify(history.json.runs));

    // It is described by the operation that produced it, never as an upload.
    const listed = await api("GET", "/api/tables");
    const derived = listed.json?.find((t) => t.name === derivedName);
    if (derived?.source !== "operation" || derived?.sourceFilename !== null)
      fail("derived dataset misdescribed its origin", JSON.stringify(derived));

    // A taken name is refused, never suffixed around.
    const again = await api("POST", "/api/operations/run", {
      body: {
        operation: "sql_step",
        parameters: { sql: "SELECT 1 AS n", name: derivedName },
      },
    });
    // Refused at admission, so it never became a run at all.
    if (again.status !== 409 || again.json?.error?.code !== "name_taken")
      fail("a taken output name was not refused", JSON.stringify(again.json));
    if (again.json?.run) fail("a refused run still minted a job", JSON.stringify(again.json));
    const after = await api("GET", "/api/tables");
    // The concern is the registry's numeric-suffix workaround, so the check is
    // for exactly that shape — a prefix match would also catch the second
    // run's own deliberately-named output.
    const suffixed = after.json.filter((t) =>
      new RegExp(`^${derivedName}_\\d+$`).test(t.name),
    );
    if (suffixed.length !== 0)
      fail("a refused run left a suffixed duplicate", suffixed.map((t) => t.name).join(","));
    if (!after.json.some((t) => t.name === derivedName))
      fail("the original output did not survive the refused run", derivedName);

    ok("saved a geometryless query result as a durable dataset, and a taken name was refused");
  }

  // 5c. a recipe: steps that remember what they were made from.
  // The whole arc a user's analysis takes — build it, run it, break it,
  // watch the graph say so — through the documented API and nothing else.
  {
    const settleRecipeRun = async (recipeId, runId, what) => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const polled = await api("GET", `/api/recipes/${recipeId}/runs/${runId}`);
        if (polled.json?.run?.outcome) return polled.json.run;
        if (Date.now() > deadline)
          fail(`${what}: recipe run never reached an outcome`, JSON.stringify(polled.json));
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    const created = await api("POST", "/api/recipes", {
      body: { name: "Journey recipe" },
    });
    if (created.status !== 201 || !created.json?.recipe?.id)
      fail("recipe not created", JSON.stringify(created.json));
    const recipeId = created.json.recipe.id;

    const one = `${tableName}_r1`;
    const two = `${tableName}_r2`;
    const addStep = async (parameters) => {
      const r = await api("POST", `/api/recipes/${recipeId}/steps`, {
        body: { operation: "sql_step", parameters },
      });
      if (r.status !== 201 || !r.json?.step?.id)
        fail("step not added", JSON.stringify(r.json));
      return r.json.step;
    };
    const stepOne = await addStep({
      sql: `SELECT name, riders FROM ${tableName}`,
      name: one,
    });
    const stepTwo = await addStep({
      sql: `SELECT count(*) AS n FROM ${one}`,
      name: two,
    });
    if (stepOne.condition !== "never_run")
      fail("a step with no output was not 'never run'", stepOne.condition);

    // The canvas layout document: beside the recipe, never in it.
    const sortedEntries = (map) => JSON.stringify(Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
    const sameLayout = (got, want) =>
      sortedEntries(got?.steps) === sortedEntries(want.steps) &&
      sortedEntries(got?.sources) === sortedEntries(want.sources) &&
      JSON.stringify(got?.notes) === JSON.stringify(want.notes);
    const layoutDoc = {
      steps: { [stepOne.id]: { x: 360, y: 40 }, [stepTwo.id]: { x: 680, y: 40 } },
      sources: { [tableName]: { x: 40, y: 60 }, journey_loose_table: { x: 40, y: 330 } },
      notes: [{ id: "intake", x: 20, y: 20, w: 420, h: 300, color: "yellow", text: "---\nlabel: intake\n---\n## Intake" }],
    };
    {
      const empty = await api("GET", `/api/recipes/${recipeId}/layout`);
      if (empty.status !== 200 || empty.json?.layout?.updatedAt !== null || empty.json?.layout?.notes?.length !== 0)
        fail("an unarranged recipe did not read the empty document", JSON.stringify(empty.json));
      const editedBefore = (await api("GET", `/api/recipes/${recipeId}`)).json?.recipe?.updatedAt;
      const put = await api("PUT", `/api/recipes/${recipeId}/layout`, {
        body: { ...layoutDoc, steps: { ...layoutDoc.steps, "not-a-node": { x: 1, y: 1 } } },
      });
      if (put.status !== 200) fail("the layout was not accepted", JSON.stringify(put.json));
      const back = await api("GET", `/api/recipes/${recipeId}/layout`);
      const stored = back.json?.layout ?? {};
      if (!sameLayout(stored, layoutDoc) || typeof stored.updatedAt !== "string")
        fail("the layout did not read back as written, with the unknown node dropped", JSON.stringify(back.json));
      const editedAfter = (await api("GET", `/api/recipes/${recipeId}`)).json?.recipe?.updatedAt;
      if (!(editedAfter > editedBefore)) fail("a changed layout write did not count as an edit", `${editedBefore} → ${editedAfter}`);
      const same = await api("PUT", `/api/recipes/${recipeId}/layout`, { body: layoutDoc });
      const editedAgain = (await api("GET", `/api/recipes/${recipeId}`)).json?.recipe?.updatedAt;
      if (same.status !== 200 || editedAgain !== editedAfter) fail("an identical layout write counted as an edit", `${editedAfter} → ${editedAgain}`);
      const refused = await api("PUT", `/api/recipes/${recipeId}/layout`, {
        body: { notes: [{ ...layoutDoc.notes[0], color: "teal" }] },
      });
      if (refused.status !== 400 || !/color/.test(refused.json?.error?.message ?? ""))
        fail("a note in a seventh colour was not refused by name", JSON.stringify(refused.json));
      ok("the recipe's layout document was written, read back, counted once as an edit, and refused a bad note");
    }

    // The rule is enforced at the change, not at the run: a step may read
    // workspace tables and earlier steps only.
    const backwards = await api("POST", `/api/recipes/${recipeId}/steps`, {
      body: {
        operation: "sql_step",
        parameters: { sql: `SELECT * FROM ${two}_later`, name: `${two}_later` },
      },
    });
    if (backwards.status !== 400)
      fail("a self-reading step was not refused at the edit", JSON.stringify(backwards.json));

    // Asked before it is committed to: the blast radius is knowable up front.
    const plan = await api("POST", `/api/recipes/${recipeId}/runs`, {
      body: { plan: true, fromStepId: stepTwo.id },
    });
    if (plan.status !== 200 || plan.json?.plan?.wide !== false)
      fail("a leaf re-run was not reported narrow", JSON.stringify(plan.json));
    const wholePlan = await api("POST", `/api/recipes/${recipeId}/runs`, {
      body: { plan: true },
    });
    if (wholePlan.json?.plan?.wide !== true)
      fail("running the whole recipe was not reported wide", JSON.stringify(wholePlan.json));

    // Run it: dependency order, and its own durable result.
    const started = await api("POST", `/api/recipes/${recipeId}/runs`, { body: {} });
    if (started.status !== 202 || !started.json?.run?.id)
      fail("recipe run was not accepted", JSON.stringify(started.json));
    const finished = await settleRecipeRun(recipeId, started.json.run.id, "run all");
    if (finished.outcome !== "completed")
      fail("the recipe run did not complete", JSON.stringify(finished));
    const produced = (finished.outputs ?? []).map((o) => o.name).sort();
    if (produced.join(",") !== [one, two].sort().join(","))
      fail("the run did not name every output it produced", produced.join(","));

    const counted = await api("POST", "/api/query", { body: { sql: `SELECT n FROM ${two}` } });
    if (Number(counted.json?.preview?.[0]?.n) !== 3)
      fail("the second step did not read the first's output", JSON.stringify(counted.json));

    // Now move the ground under the second step: re-run the first alone, so
    // what the second read is a generation behind. It goes stale and names the
    // input that did it — while the first, which just ran, is current.
    const beforeRerun = (await api("GET", "/api/tables")).json.find((t) => t.name === one);
    const rerun = await api("POST", `/api/recipes/${recipeId}/steps/${stepOne.id}/run`);
    if (rerun.status !== 202) fail("step re-run was not accepted", JSON.stringify(rerun.json));
    // A node's own run is one of the recipe's runs: one member, listed.
    if (rerun.json.run.kind !== "single" || rerun.json.run.members?.length !== 1)
      fail("a step's own run was not a single-member recipe run", JSON.stringify(rerun.json));
    const singleRun = await settleRecipeRun(recipeId, rerun.json.run.id, "step re-run");
    if (singleRun.outcome !== "completed" || singleRun.members[0]?.attempt?.state !== "succeeded")
      fail("the single run's member did not carry a succeeded attempt", JSON.stringify(singleRun));

    // And that re-run kept the output's identity, so layers built on it keep
    // pointing at fresh data with no re-wiring.
    const afterRerun = (await api("GET", "/api/tables")).json.find((t) => t.name === one);
    if (!beforeRerun || afterRerun?.id !== beforeRerun.id)
      fail("a re-run did not keep the output's identity", JSON.stringify(afterRerun));

    {
      const read = await api("GET", `/api/recipes/${recipeId}`);
      const steps = read.json?.recipe?.steps ?? [];
      if (steps[0]?.condition !== "current")
        fail("the step that just ran was not current", JSON.stringify(steps[0]));
      if (steps[1]?.condition !== "stale")
        fail("a step whose upstream re-ran was not stale", JSON.stringify(steps[1]));
      const cause = steps[1]?.causes?.[0];
      if (cause?.reason !== "upstream_re_ran" || cause?.tableName !== one)
        fail("the stale cause did not name its source", JSON.stringify(steps[1]?.causes));
    }

    // Re-running the top brings the chain current, in order, without the user
    // sequencing anything.
    {
      const again = await api("POST", `/api/recipes/${recipeId}/runs`, {
        body: { fromStepId: stepOne.id },
      });
      if (again.status !== 202)
        fail("re-run from here was not accepted", JSON.stringify(again.json));
      const brought = await settleRecipeRun(recipeId, again.json.run.id, "re-run from here");
      if (brought.outcome !== "completed")
        fail("the cascade did not complete", JSON.stringify(brought));
      const now = await api("GET", `/api/recipes/${recipeId}`);
      const conditions = (now.json?.recipe?.steps ?? []).map((s) => s.condition);
      if (conditions.some((c) => c !== "current"))
        fail("re-running the top did not bring the chain current", conditions.join(","));
    }

    // Duplicating: an independent copy that can run.
    {
      const dup = await api("POST", `/api/recipes/${recipeId}/duplicate`);
      if (dup.status !== 201 || !dup.json?.recipe?.id)
        fail("duplicate was not accepted", JSON.stringify(dup.json));
      const copy = dup.json.recipe;
      if (copy.name !== "Journey recipe copy" || copy.origin !== "workflow")
        fail("the copy's name or origin is wrong", `${copy.name} / ${copy.origin}`);
      // The layout came with it, under the copy's node identities.
      {
        const copied = (await api("GET", `/api/recipes/${copy.id}/layout`)).json?.layout ?? {};
        const expected = {
          [copy.steps[0].id]: layoutDoc.steps[stepOne.id],
          [copy.steps[1].id]: layoutDoc.steps[stepTwo.id],
        };
        if (!sameLayout(copied, { ...layoutDoc, steps: expected }))
          fail("the copy did not carry the layout under its own node identities", JSON.stringify(copied));
      }
      const names = copy.steps.map((s) => s.parameters.name);
      if (names.join(",") !== `${one}_copy,${two}_copy`)
        fail("the copy's outputs were not renamed to free names", names.join(","));
      if (copy.steps[1].parameters.sql !== `SELECT count(*) AS n FROM ${one}_copy`)
        fail("the copy's second step still reads the original's output", copy.steps[1].parameters.sql);
      if (copy.steps.some((s) => s.condition !== "never_run" || s.output !== null))
        fail("the copy carries run history", JSON.stringify(copy.steps.map((s) => s.condition)));
      if (copy.summary?.status !== "never_run")
        fail("the copy's summary is not never_run", JSON.stringify(copy.summary));
      const listed = await api("GET", "/api/recipes?origin=workflow");
      if (!listed.json?.recipes?.some((r) => r.id === copy.id))
        fail("the copy is not listed as a workflow", JSON.stringify(listed.json?.recipes?.map((r) => r.id)));
      const ran = await api("POST", `/api/recipes/${copy.id}/runs`, { body: {} });
      if (ran.status !== 202) fail("the copy's run was not accepted", JSON.stringify(ran.json));
      const done = await settleRecipeRun(copy.id, ran.json.run.id, "run the copy");
      if (done.outcome !== "completed") fail("the copy did not run to completion", JSON.stringify(done));
      const counted2 = await api("POST", "/api/query", { body: { sql: `SELECT n FROM ${two}_copy` } });
      if (Number(counted2.json?.preview?.[0]?.n) !== 3)
        fail("the copy's second step did not read the copy's first output", JSON.stringify(counted2.json));
      const untouched = (await api("GET", "/api/tables")).json.find((t) => t.name === one);
      if (untouched?.id !== afterRerun?.id)
        fail("running the copy touched the original's dataset", JSON.stringify(untouched));
      const copyRead = await api("GET", `/api/recipes/${copy.id}`);
      if (copyRead.json?.recipe?.summary?.status !== "up_to_date")
        fail("the copy is not up to date after its run", JSON.stringify(copyRead.json?.recipe?.summary));
      const removedCopy = await api("DELETE", `/api/recipes/${copy.id}`);
      if (removedCopy.status !== 200)
        fail("the copy could not be deleted", JSON.stringify(removedCopy.json));
      ok("a workflow was duplicated into a copy that ran on its own outputs and left the original alone");
    }

    // The editing contract: names, the order inside an edit,
    // SQL that does not parse, proposals and their discard, removal truth.
    {
      const frozen = await api("PATCH", `/api/recipes/${recipeId}/steps/${stepOne.id}`, {
        body: { parameters: { sql: `SELECT name, riders FROM ${tableName}`, name: `${one}_renamed` } },
      });
      if (frozen.status !== 400 || !/keeps its name/.test(frozen.json?.error?.message ?? ""))
        fail("a produced output's name was not frozen", JSON.stringify(frozen.json));
      const taken = await api("POST", `/api/recipes/${recipeId}/steps`, {
        body: { operation: "sql_step", parameters: { sql: "SELECT 1 AS n", name: one } },
      });
      if (taken.status !== 400 || taken.json?.error?.code !== "name_taken")
        fail("a sibling's declared name was not refused", JSON.stringify(taken.json));
      const unparsed = await api("POST", `/api/recipes/${recipeId}/steps`, {
        body: { operation: "sql_step", parameters: { sql: "SELEC nonsense FROM", name: `${tableName}_r3` } },
      });
      if (unparsed.status !== 201 || unparsed.json?.step?.reads?.length !== 0)
        fail("SQL that does not parse was not accepted with empty reads", JSON.stringify(unparsed.json));
      const three = unparsed.json.step;
      // Step one comes to read step three's output: a proposal (it has run) that
      // moves one and its dependent two after three.
      const linked = await api("PATCH", `/api/recipes/${recipeId}/steps/${stepOne.id}`, {
        body: { parameters: { sql: `SELECT * FROM ${tableName}_r3`, name: one } },
      });
      if (linked.status !== 200 || linked.json?.applied !== "proposed")
        fail("the later-producer edit was not accepted as a proposal", JSON.stringify(linked.json));
      const ordered = (await api("GET", `/api/recipes/${recipeId}`)).json?.recipe?.steps?.map((s) => s.parameters.name) ?? [];
      if (ordered.join(",") !== `${tableName}_r3,${one},${two}`)
        fail("the reader and its dependent did not move after the producer", ordered.join(","));
      const dropped = await api("DELETE", `/api/recipes/${recipeId}/steps/${stepOne.id}/proposal`);
      if (dropped.status !== 200 || dropped.json?.discarded !== true || dropped.json?.step?.proposedParameters !== null)
        fail("the pending edit was not discarded", JSON.stringify(dropped.json));
      const removedThree = await api("DELETE", `/api/recipes/${recipeId}/steps/${three.id}`);
      if (removedThree.status !== 200 || removedThree.json?.output?.state !== "never" || removedThree.json?.outputsRemain !== false)
        fail("removing a never-run node did not say so", JSON.stringify(removedThree.json));
      ok("the editing contract held: a frozen name, a sibling's name refused, unparsed SQL saved, a later producer ordered, a proposal discarded, a removal told truthfully");
    }

    // Deleting the recipe leaves its datasets standing — the disclosure the
    // confirmation is for.
    const removed = await api("DELETE", `/api/recipes/${recipeId}`);
    if (removed.status !== 200 || removed.json?.outputsRemain !== true)
      fail("recipe deletion did not disclose that outputs remain", JSON.stringify(removed.json));
    const survivors = (await api("GET", "/api/tables")).json.filter((t) =>
      [one, two].includes(t.name),
    );
    if (survivors.length !== 2)
      fail("deleting a recipe destroyed its outputs", JSON.stringify(survivors.map((t) => t.name)));

    ok("a recipe ran in dependency order, went stale when its data moved, and left its datasets behind");
  }

  // 5d. metric truth: a measurement means ground metres, and the
  // record says where it was measured. A wrong buffer looks exactly like a
  // right one, so the assertion is a number rather than a shape.
  {
    const settle = async (runId, what) => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const polled = await api("GET", `/api/operations/runs/${runId}`);
        const state = polled.json?.run?.state;
        if (["succeeded", "failed", "cancelled"].includes(state)) return polled.json.run;
        if (Date.now() > deadline) fail(`${what}: run never settled`, state);
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    // The catalog says which parameter is a ground distance, without the
    // caller knowing the verb in advance.
    const cat = await api("GET", "/api/operations");
    const buffer = cat.json?.operations?.find((o) => o.id === "buffer");
    if (!buffer) fail("the catalog does not offer a buffer", JSON.stringify(cat.json));
    const distance = buffer.parameters.find((p) => p.name === "distance");
    if (distance?.unit !== "metres")
      fail("the buffer's distance is not declared as a measurement", JSON.stringify(distance));

    // A run over an assumed-CRS input is accepted, and says so before it runs.
    const ringName = `${tableName}_ring`;
    const accepted = await api("POST", "/api/operations/run", {
      body: {
        operation: "buffer",
        parameters: { input: tableName, distance: 500, name: ringName },
      },
    });
    if (accepted.status !== 202)
      fail("a buffer was not accepted", JSON.stringify(accepted.json));
    if (!accepted.json.run.warnings?.some((w) => /assumed/i.test(w)))
      fail("an assumed coordinate system was not reported on the accepted run",
        JSON.stringify(accepted.json.run));
    const settled = await settle(accepted.json.run.id, "buffer");
    if (settled.state !== "succeeded")
      fail("the buffer did not succeed", JSON.stringify(settled));

    // The ring stands 500 m from its input **on the ground**: 2 x 500 m of
    // latitude is 0.008998 degrees, and the same ring is wider in degrees
    // east-west by 1/cos(latitude). A degree buffer fails the second.
    const measured = await api("POST", "/api/query", {
      body: {
        sql: `SELECT ST_YMax(ST_Extent(geometry)) - ST_YMin(ST_Extent(geometry)) AS h,
                     ST_XMax(ST_Extent(geometry)) - ST_XMin(ST_Extent(geometry)) AS w
              FROM ${ringName}`,
      },
    });
    const h = Number(measured.json?.preview?.[0]?.h);
    const w = Number(measured.json?.preview?.[0]?.w);
    const expectedH = (2 * 500) / 111132;
    if (!(Math.abs(h / expectedH - 1) < 0.01))
      fail("the ring is not 500 m tall on the ground", `height ${h} deg`);
    if (!(w > h * 1.2))
      fail("the ring is not wider in degrees than it is tall — it was measured in degrees, not metres",
        `w ${w} h ${h}`);

    // The output records where it measured.
    const tables = await api("GET", "/api/tables");
    const ring = tables.json.find((t) => t.name === ringName);
    const measurement = ring?.sourceParams?.measurement;
    if (!measurement?.crs?.distance)
      fail("the output does not record its measurement CRS", JSON.stringify(ring?.sourceParams));
    if (!Array.isArray(measurement.assumedCrs))
      fail("the output does not record the assumed-CRS observation", JSON.stringify(measurement));

    // An area and a length come back separately, each in its own unit.
    const measuredName = `${tableName}_measured`;
    const columns = await api("POST", "/api/operations/run", {
      body: {
        operation: "measure_columns",
        parameters: { input: ringName, measures: ["area", "length"], name: measuredName },
      },
    });
    if (columns.status !== 202)
      fail("measure columns was not accepted", JSON.stringify(columns.json));
    const columnsSettled = await settle(columns.json.run.id, "measure columns");
    if (columnsSettled.state !== "succeeded")
      fail("measure columns did not succeed", JSON.stringify(columnsSettled));
    const areas = await api("POST", "/api/query", {
      body: { sql: `SELECT area_m2, length_m FROM ${measuredName} LIMIT 1` },
    });
    const area = Number(areas.json?.preview?.[0]?.area_m2);
    const length = Number(areas.json?.preview?.[0]?.length_m);
    // A 500 m ring: pi*r^2 = 785,398 m2 and 2*pi*r = 3,142 m, both published.
    if (!(Math.abs(area / (Math.PI * 500 * 500) - 1) < 0.02))
      fail("the measured area is not the known answer", `${area} m2`);
    // Separately asserted, because the strategy splits on exactly this: a
    // suite checking only areas passes an equal-area projection measuring a
    // radius. A polygon whose length came back 0 fails here.
    if (!(Math.abs(length / (2 * Math.PI * 500) - 1) < 0.02))
      fail("the measured length is not the known answer", `${length} m`);

    ok("a buffer measured 500 m on the ground, an area and a length agreed with their known answers, and the output recorded where it measured");
  }

  // 6. a mutating statement is rejected
  {
    const r = await api("POST", "/api/query", {
      body: { sql: `DELETE FROM ${tableName}` },
    });
    if (r.status !== 400 || r.json?.error?.code !== "sql_rejected")
      fail("mutation was not rejected", JSON.stringify(r.json));
    ok("mutation rejected, data intact");
  }

  // 7. create a map
  let mapId;
  {
    const r = await api("POST", "/api/maps", { body: { name: "Journey map" } });
    if (r.status !== 201 || !r.json?.id) fail("map not created", JSON.stringify(r.json));
    mapId = r.json.id;
    ok(`created map ${mapId}`);
  }

  // 8. create a layer from a SQL result
  let layerId;
  {
    const r = await api("POST", `/api/maps/${mapId}/layers`, {
      body: { name: "Stations", sql: `SELECT name, riders, geometry FROM ${tableName}` },
    });
    if (r.status !== 201 || r.json?.style?.fill?.type !== "constant")
      fail("layer not created with default style", JSON.stringify(r.json));
    layerId = r.json.id;
    ok("created a layer with publication-ready default style");
  }

  // 9. render the layer
  {
    const r = await api("GET", `/api/layers/${layerId}/render`);
    if (r.status !== 200 || r.json?.ok !== true || r.json?.featureCount !== 3)
      fail("layer did not render", JSON.stringify(r.json));
    ok("layer rendered 3 GeoJSON features");
  }

  // 10. edit the layer's SQL — same layer, different render
  {
    const patch = await api("PATCH", `/api/layers/${layerId}`, {
      body: { sql: `SELECT name, riders, geometry FROM ${tableName} WHERE riders > 400` },
    });
    if (patch.status !== 200) fail("layer SQL edit failed", JSON.stringify(patch.json));
    const r = await api("GET", `/api/layers/${layerId}/render`);
    if (r.json?.featureCount !== 2)
      fail("edited layer did not re-render", JSON.stringify(r.json));
    ok("edited layer SQL; render reflects it (source of truth)");
  }

  // 11. read the map with its layers
  {
    const r = await api("GET", `/api/maps/${mapId}`);
    if (r.status !== 200 || r.json?.layers?.length !== 1)
      fail("map read did not include layers", JSON.stringify(r.json));
    ok("read map with its layer");
  }

  // 12. color the layer by an attribute (data-driven fill)
  {
    const fill = await api("POST", `/api/layers/${layerId}/fill`, {
      body: { attribute: "riders", method: "quantile" },
    });
    if (fill.status !== 200 || fill.json?.type !== "quantile")
      fail("classification failed", JSON.stringify(fill.json));
    ok("classified the layer by a numeric attribute (quantile)");
  }

  // 12b. equal-interval fill honors palette, class count, and reverse
  {
    const fill = await api("POST", `/api/layers/${layerId}/fill`, {
      body: {
        attribute: "riders",
        method: "equal",
        palette: "ice_and_fire",
        classes: 4,
        reversed: true,
      },
    });
    if (
      fill.status !== 200 ||
      fill.json?.method !== "equal" ||
      fill.json?.palette !== "ice_and_fire" ||
      fill.json?.reversed !== true
    )
      fail("equal-interval fill options ignored", JSON.stringify(fill.json));
    const unknown = await api("POST", `/api/layers/${layerId}/fill`, {
      body: { attribute: "riders", method: "quantile", palette: "nope" },
    });
    if (unknown.status !== 400)
      fail("unknown palette accepted", JSON.stringify(unknown.json));
    ok("equal-interval fill with palette/classes/reverse; bad palette refused");
  }

  // 12c. new layers cycle kepler default colors
  let secondLayerId;
  {
    const r = await api("POST", `/api/maps/${mapId}/layers`, {
      body: { name: "All stations", sql: `SELECT * FROM ${tableName}` },
    });
    if (r.status !== 201) fail("second layer not created", JSON.stringify(r.json));
    secondLayerId = r.json.id;
    const c = r.json?.style?.fill?.color;
    if (!c || (c.r === 18 && c.g === 147 && c.b === 154))
      fail("second layer did not advance the color cycle", JSON.stringify(c));
    ok("second layer gets the next kepler cycle color");
  }

  // 12d. duplicate a layer — full copy, suffixed, on top
  {
    await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: { tooltip: ["name", "riders"], inLegend: false },
    });
    const r = await api("POST", `/api/layers/${secondLayerId}/duplicate`);
    if (
      r.status !== 201 ||
      r.json?.name !== "All stations copy" ||
      JSON.stringify(r.json?.tooltip) !== JSON.stringify(["name", "riders"]) ||
      r.json?.inLegend !== false
    )
      fail("duplicate is not a full copy", JSON.stringify(r.json));
    ok("duplicated a layer: full copy, suffixed name, stacked on top");
  }

  // 12e. layer order is writable and round-trips
  {
    const before = await api("GET", `/api/maps/${mapId}`);
    const ids = before.json.layers.map((l) => l.id);
    const reversed = [...ids].reverse();
    const r = await api("PATCH", `/api/maps/${mapId}`, {
      body: { layerOrder: reversed },
    });
    const after = r.json?.layers?.map((l) => l.id);
    if (r.status !== 200 || JSON.stringify(after) !== JSON.stringify(reversed))
      fail("layer order did not round-trip", JSON.stringify(after));
    ok("reordered layers; draw order round-trips");
  }

  // 12f. tooltip fields and legend inclusion round-trip
  {
    const r = await api("GET", `/api/layers/${secondLayerId}`);
    if (
      JSON.stringify(r.json?.tooltip) !== JSON.stringify(["name", "riders"]) ||
      r.json?.inLegend !== false
    )
      fail("tooltip/legend fields did not persist", JSON.stringify(r.json));
    const reset = await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: { tooltip: null, inLegend: true },
    });
    if (reset.json?.tooltip !== null || reset.json?.inLegend !== true)
      fail("tooltip/legend reset failed", JSON.stringify(reset.json));
    ok("tooltip fields and legend inclusion persist and reset");
  }

  // 12g. basemap choice persists; invalid values are refused
  {
    const r = await api("PATCH", `/api/maps/${mapId}`, {
      body: { basemap: "light" },
    });
    if (r.status !== 200 || r.json?.basemap !== "light")
      fail("basemap not persisted", JSON.stringify(r.json));
    const bad = await api("PATCH", `/api/maps/${mapId}`, {
      body: { basemap: "sepia" },
    });
    if (bad.status !== 400)
      fail("invalid basemap accepted", JSON.stringify(bad.json));
    ok("basemap persists; invalid basemap refused");
  }

  // 12h. hexbin viz: server-side aggregation with an automatic value fill
  {
    const r = await api("PATCH", `/api/layers/${layerId}`, {
      body: {
        viz: { type: "hexbin", cellKm: 1.22, aggregate: { fn: "count" } },
      },
    });
    if (
      r.status !== 200 ||
      r.json?.viz?.type !== "hexbin" ||
      r.json?.viz?.fill?.type !== "quantile" ||
      r.json?.viz?.fill?.attribute !== "value"
    )
      fail("hexbin viz did not get an automatic value fill", JSON.stringify(r.json?.viz));
    const render = await api("GET", `/api/layers/${layerId}/render`);
    const feature = render.json?.geojson?.features?.[0];
    if (
      render.json?.ok !== true ||
      feature?.properties?.value === undefined ||
      feature?.properties?.count === undefined ||
      feature?.geometry?.type !== "Polygon"
    )
      fail("hexbin did not render cells", JSON.stringify(feature));
    const fields = await api("GET", `/api/layers/${layerId}/fields`);
    if (
      JSON.stringify(fields.json?.styling?.map((f) => f.name)) !==
        JSON.stringify(["value", "count"]) ||
      !fields.json?.filterable?.some((f) => f.name === "riders")
    )
      fail("aggregated fields not split styling/filterable", JSON.stringify(fields.json));
    const bad = await api("PATCH", `/api/layers/${layerId}`, {
      body: { viz: { type: "hexbin", cellKm: 99999, aggregate: { fn: "count" } } },
    });
    if (bad.status !== 400) fail("invalid viz accepted", JSON.stringify(bad.json));
    ok("hexbin aggregates server-side: cells, value fill, split fields; bad viz refused");
  }

  // 12h2. layer types: flow CSV → arc endpoints; icon glyph; cluster
  {
    // A flow table's origin pair becomes its geometry (recognition rule 3),
    // so the four-numeric-column story works end to end.
    const flowCsv = [
      "route,origin_lon,origin_lat,dest_lon,dest_lat,trips",
      "a,13.40,52.52,13.30,52.51,900",
      "b,13.36,52.48,13.30,52.51,120",
    ].join("\n");
    const form = new FormData();
    form.append("file", new Blob([flowCsv]), "journey_flows.csv");
    const up = await api("POST", "/api/tables", { form });
    if (up.status !== 201 || up.json?.geometryType !== "POINT")
      fail("flow CSV did not land with origin-pair geometry", JSON.stringify(up.json));
    const flowLayer = await api("POST", `/api/maps/${mapId}/layers`, {
      body: {
        name: "Flows",
        sql: `SELECT route, origin_lon, origin_lat, dest_lon, dest_lat, trips, geometry FROM ${up.json.name}`,
      },
    });
    if (flowLayer.status !== 201)
      fail("flow layer not created", JSON.stringify(flowLayer.json));
    const flowId = flowLayer.json.id;
    const arc = await api("PATCH", `/api/layers/${flowId}`, {
      body: {
        viz: {
          type: "arc",
          origin: { kind: "lonlat", lon: "origin_lon", lat: "origin_lat" },
          dest: { kind: "lonlat", lon: "dest_lon", lat: "dest_lat" },
          height: 0.8,
          targetColor: { r: 122, g: 78, b: 147, a: 1 },
        },
      },
    });
    if (arc.status !== 200 || arc.json?.viz?.type !== "arc")
      fail("arc viz not accepted", JSON.stringify(arc.json));
    const arcRender = await api("GET", `/api/layers/${flowId}/render`);
    const arcFeature = arcRender.json?.geojson?.features?.[0];
    if (
      arcRender.json?.ok !== true ||
      arcRender.json?.featureCount !== 2 ||
      arcFeature?.geometry?.type !== "LineString" ||
      arcFeature?.geometry?.coordinates?.length !== 2 ||
      arcFeature?.properties?.trips === undefined
    )
      fail("arc did not render O→D lines", JSON.stringify(arcFeature));
    const line = await api("PATCH", `/api/layers/${flowId}`, {
      body: { viz: { ...arc.json.viz, type: "line" } },
    });
    if (line.status !== 200 || line.json?.viz?.type !== "line")
      fail("line viz not accepted", JSON.stringify(line.json));
    const badArc = await api("PATCH", `/api/layers/${flowId}`, {
      body: { viz: { type: "arc", origin: null, dest: null, height: 99 } },
    });
    if (badArc.status !== 400)
      fail("invalid arc height accepted", JSON.stringify(badArc.json));

    // Icon and cluster ride a scratch point layer — the journey's main
    // layer keeps its hexbin state for the publish steps downstream.
    const probe = await api("POST", `/api/maps/${mapId}/layers`, {
      body: {
        name: "TypesProbe",
        sql: `SELECT name, riders, geometry FROM ${tableName}`,
      },
    });
    if (probe.status !== 201)
      fail("probe layer not created", JSON.stringify(probe.json));
    const probeId = probe.json.id;
    const icon = await api("PATCH", `/api/layers/${probeId}`, {
      body: { viz: { type: "icon", glyph: "cafe" } },
    });
    if (icon.status !== 200 || icon.json?.viz?.glyph !== "cafe")
      fail("icon viz not accepted", JSON.stringify(icon.json));
    const badIcon = await api("PATCH", `/api/layers/${probeId}`, {
      body: { viz: { type: "icon", glyph: "definitely-not-maki" } },
    });
    if (badIcon.status !== 400)
      fail("unknown glyph accepted", JSON.stringify(badIcon.json));
    const cluster = await api("PATCH", `/api/layers/${probeId}`, {
      body: {
        viz: {
          type: "cluster",
          radiusPx: 64,
          color: { fn: "avg", attribute: "riders" },
          showCounts: true,
        },
      },
    });
    if (cluster.status !== 200 || cluster.json?.viz?.type !== "cluster")
      fail("cluster viz not accepted", JSON.stringify(cluster.json));
    const clusterRender = await api("GET", `/api/layers/${probeId}/render`);
    if (
      clusterRender.json?.ok !== true ||
      clusterRender.json?.mode !== "inline"
    )
      fail("cluster layer did not stay inline", JSON.stringify(clusterRender.json));
    const badCluster = await api("PATCH", `/api/layers/${probeId}`, {
      body: { viz: { type: "cluster", radiusPx: 4, color: "fixed", showCounts: true } },
    });
    if (badCluster.status !== 400)
      fail("invalid cluster radius accepted", JSON.stringify(badCluster.json));
    for (const id of [probeId, flowId]) {
      const gone = await api("DELETE", `/api/layers/${id}`);
      if (gone.status !== 204) fail("layer-types cleanup failed", String(gone.status));
    }
    ok("layer types: flow CSV → arc/line O→D; icon glyph; cluster; bad configs refused");
  }

  // 12i. filters: seeded stats, refinement, composition before aggregation
  {
    const stats = await api("GET", `/api/layers/${secondLayerId}/fields/riders`);
    if (stats.status !== 200 || stats.json?.min !== 120 || stats.json?.max !== 900)
      fail("field stats did not seed the real extent", JSON.stringify(stats.json));
    const filtered = await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: { filters: [{ field: "riders", kind: "range", min: 400, max: null }] },
    });
    if (filtered.status !== 200)
      fail("filter not accepted", JSON.stringify(filtered.json));
    const render = await api("GET", `/api/layers/${secondLayerId}/render`);
    if (render.json?.featureCount !== 3 || render.json?.liveFiltered !== true)
      fail("live filter did not stay client-enforced", JSON.stringify(render.json));
    const agg = await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: { viz: { type: "grid", cellKm: 1000, aggregate: { fn: "count" } } },
    });
    if (agg.status !== 200) fail("grid viz refused", JSON.stringify(agg.json));
    const cells = await api("GET", `/api/layers/${secondLayerId}/render`);
    const total = cells.json?.geojson?.features?.reduce(
      (s, f) => s + Number(f.properties.count),
      0,
    );
    if (cells.json?.ok !== true || total !== 2)
      fail("filters did not compose before aggregation", JSON.stringify(cells.json));
    const bad = await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: { filters: [{ field: "riders", kind: "nope" }] },
    });
    if (bad.status !== 400) fail("invalid filter accepted", JSON.stringify(bad.json));
    ok("filters seed from real stats, stay live on raw layers, and compose before aggregation");
  }

  // 12j. removing filters and viz restores the original result exactly
  {
    const r = await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: { filters: [], viz: { type: "points" } },
    });
    if (r.status !== 200) fail("reset failed", JSON.stringify(r.json));
    const render = await api("GET", `/api/layers/${secondLayerId}/render`);
    if (render.json?.featureCount !== 3)
      fail("reset did not restore the original result", JSON.stringify(render.json));
    const heat = await api("PATCH", `/api/layers/${secondLayerId}`, {
      body: {
        viz: { type: "heatmap", radiusPx: 40, intensity: 1, weight: "riders" },
      },
    });
    if (heat.status !== 200 || heat.json?.viz?.type !== "heatmap")
      fail("heatmap viz refused", JSON.stringify(heat.json));
    ok("removing filters/viz restores the result; heatmap viz persists");
  }

  // 12k. legend text overrides round-trip; invalid labels refused
  {
    const r = await api("PATCH", `/api/layers/${layerId}`, {
      body: { legendTitle: "Stations by traffic", legendLabels: ["low", null, "high"] },
    });
    if (
      r.status !== 200 ||
      r.json?.legendTitle !== "Stations by traffic" ||
      JSON.stringify(r.json?.legendLabels) !== JSON.stringify(["low", null, "high"])
    )
      fail("legend text did not round-trip", JSON.stringify(r.json));
    const bad = await api("PATCH", `/api/layers/${layerId}`, {
      body: { legendLabels: [42] },
    });
    if (bad.status !== 400)
      fail("invalid legend labels accepted", JSON.stringify(bad.json));
    ok("legend title and labels round-trip; invalid labels refused");
  }

  // 12n. field kinds, distributions, time filters, legend attribute names
  // — on a separate map so the publish assertions stay untouched.
  {
    const pingsCsv = [
      "label,seen,lon,lat",
      "a,2021-03-01 08:30:00,13.40,52.50",
      "b,2021-03-02 09:00:00,13.30,52.40",
      "c,2021-04-01 10:15:00,13.20,52.60",
    ].join("\n");
    const form = new FormData();
    form.append("file", new Blob([pingsCsv]), "journey_pings.csv");
    const up = await api("POST", "/api/tables", { form });
    if (up.status !== 201) fail("pings upload failed", JSON.stringify(up.json));
    const pingsTable = up.json.name;
    const pm = await api("POST", "/api/maps", { body: { name: "Journey pings" } });
    const lr = await api("POST", `/api/maps/${pm.json.id}/layers`, {
      body: { name: "Pings", sql: `SELECT label, seen, geometry FROM ${pingsTable}` },
    });
    if (lr.status !== 201) fail("pings layer not created", JSON.stringify(lr.json));
    const pingsLayerId = lr.json.id;

    const fields = await api("GET", `/api/layers/${pingsLayerId}/fields`);
    const kindOf = (n) => fields.json?.filterable?.find((f) => f.name === n)?.kind;
    if (kindOf("seen") !== "time" || kindOf("label") !== "text")
      fail("field kinds not reported", JSON.stringify(fields.json?.filterable));

    const seen = await api("GET", `/api/layers/${pingsLayerId}/fields/seen`);
    const seenBins = (seen.json?.bins ?? []).reduce((s, n) => s + n, 0);
    if (
      seen.json?.kind !== "time" ||
      seen.json?.min !== "2021-03-01T08:30:00" ||
      seen.json?.max !== "2021-04-01T10:15:00" ||
      seenBins !== 3
    )
      fail("time stats lack ISO extent or distribution", JSON.stringify(seen.json));

    const riders = await api("GET", `/api/layers/${secondLayerId}/fields/riders`);
    const riderBins = (riders.json?.bins ?? []).reduce((s, n) => s + n, 0);
    if (riders.json?.kind !== "numeric" || riderBins !== 3)
      fail("numeric stats lack a distribution", JSON.stringify(riders.json));
    ok("field kinds, ISO time extents, and distributions come from the database");

    const tf = await api("PATCH", `/api/layers/${pingsLayerId}`, {
      body: {
        filters: [{ field: "seen", kind: "timerange", min: "2021-03-15", max: null }],
      },
    });
    if (tf.status !== 200) fail("time filter refused", JSON.stringify(tf.json));
    const render = await api("GET", `/api/layers/${pingsLayerId}/render`);
    if (render.json?.featureCount !== 3 || render.json?.liveFiltered !== true)
      fail("time filter did not stay client-enforced", JSON.stringify(render.json));
    const badTime = await api("PATCH", `/api/layers/${pingsLayerId}`, {
      body: {
        filters: [{ field: "seen", kind: "timerange", min: "yesterday", max: null }],
      },
    });
    if (badTime.status !== 400)
      fail("invalid time bound accepted", JSON.stringify(badTime.json));
    ok("time filter ships live to the client; non-ISO bounds refused");

    // Legend variable name: override the hexed layer's fill channel — the
    // published view below must carry it.
    const attrs = await api("PATCH", `/api/layers/${layerId}`, {
      body: { legendAttrs: { fill: "Traffic" } },
    });
    if (attrs.status !== 200 || attrs.json?.legendAttrs?.fill !== "Traffic")
      fail("legend attrs did not round-trip", JSON.stringify(attrs.json));
    const badAttrs = await api("PATCH", `/api/layers/${layerId}`, {
      body: { legendAttrs: { glow: "nope" } },
    });
    if (badAttrs.status !== 400)
      fail("invalid legend attrs accepted", JSON.stringify(badAttrs.json));
    ok("legend variable names round-trip; unknown channels refused");

    await api("DELETE", `/api/maps/${pm.json.id}`, { raw: true });
    await api("DELETE", `/api/tables/${pingsTable}`, { raw: true });
  }

  // 12m. data-driven channels: natural breaks, outline-by-category,
  // size-by-attribute, manual overrides — on the plain points copy layer.
  let copyLayerId;
  {
    const m = await api("GET", `/api/maps/${mapId}`);
    copyLayerId = m.json?.layers?.find((l) => l.name === "All stations copy")?.id;
    if (!copyLayerId) fail("copy layer not found", JSON.stringify(m.json?.layers));

    const natural = await api("POST", `/api/layers/${copyLayerId}/fill`, {
      body: { attribute: "riders", method: "natural", classes: 3 },
    });
    if (
      natural.status !== 200 ||
      natural.json?.method !== "natural" ||
      !Array.isArray(natural.json?.breaks)
    )
      fail("natural breaks failed", JSON.stringify(natural.json));

    const strokeBy = await api("POST", `/api/layers/${copyLayerId}/fill`, {
      body: { attribute: "name", method: "categorical" },
    });
    if (strokeBy.status !== 200 || strokeBy.json?.type !== "categorical")
      fail("categorical outline paint failed", JSON.stringify(strokeBy.json));

    const scale = await api("POST", `/api/layers/${copyLayerId}/scale`, {
      body: { attribute: "riders", range: [4, 28] },
    });
    if (
      scale.status !== 200 ||
      scale.json?.domain?.[0] !== 120 ||
      scale.json?.domain?.[1] !== 900
    )
      fail("size scale did not resolve the real domain", JSON.stringify(scale.json));

    const before = await api("GET", `/api/layers/${copyLayerId}`);
    const styled = await api("PATCH", `/api/layers/${copyLayerId}`, {
      body: {
        style: {
          ...before.json.style,
          fill: natural.json,
          strokeBy: strokeBy.json,
          pointRadiusBy: scale.json,
        },
      },
    });
    if (
      styled.status !== 200 ||
      styled.json?.style?.strokeBy?.type !== "categorical" ||
      styled.json?.style?.pointRadiusBy?.attribute !== "riders" ||
      styled.json?.style?.fill?.method !== "natural"
    )
      fail("channels did not persist", JSON.stringify(styled.json?.style));
    ok("natural breaks + outline-by-category + size-by-attribute persist on one style");

    // Manual break edit persists; out-of-order is rejected with an explanation.
    const edited = {
      ...natural.json,
      breaks: natural.json.breaks.map((b, i) => (i === 0 ? b + 1 : b)),
    };
    const editOk = await api("PATCH", `/api/layers/${copyLayerId}`, {
      body: { style: { ...styled.json.style, fill: edited } },
    });
    if (
      editOk.status !== 200 ||
      editOk.json?.style?.fill?.breaks?.[0] !== natural.json.breaks[0] + 1
    )
      fail("manual break edit did not persist", JSON.stringify(editOk.json?.style?.fill));
    const scrambled = { ...edited, breaks: [...edited.breaks].reverse() };
    const badBreaks = await api("PATCH", `/api/layers/${copyLayerId}`, {
      body: { style: { ...styled.json.style, fill: scrambled } },
    });
    if (
      badBreaks.status !== 400 ||
      !/ascending/.test(badBreaks.json?.error?.message ?? "")
    )
      fail("out-of-order breaks not rejected with explanation", JSON.stringify(badBreaks.json));
    ok("manual breaks persist; out-of-order boundaries rejected with an explanation");

    // Custom class color persists ("custom" palette); bad scale range refused.
    const customFill = {
      ...edited,
      palette: "custom",
      colors: edited.colors.map((c, i) => (i === 0 ? { r: 1, g: 2, b: 3, a: 1 } : c)),
    };
    const custom = await api("PATCH", `/api/layers/${copyLayerId}`, {
      body: { style: { ...editOk.json.style, fill: customFill } },
    });
    if (custom.status !== 200 || custom.json?.style?.fill?.colors?.[0]?.r !== 1)
      fail("custom class color did not persist", JSON.stringify(custom.json?.style?.fill));
    const badScale = await api("POST", `/api/layers/${copyLayerId}/scale`, {
      body: { attribute: "riders", range: [28, 4] },
    });
    if (badScale.status !== 400)
      fail("descending scale range accepted", JSON.stringify(badScale.json));
    ok("custom class colors persist; malformed scale range refused");
  }

  // 12l. tiled rendering: over-cap simple features switch to tiles.
  // Needs an instance with a testable cap — generating hundreds of
  // thousands of rows in a journey is not reasonable, so this section runs
  // when the configured cap is low (CI sets DEZFIL_RENDER_CAP_FEATURES).
  {
    const config = await api("GET", "/api/config");
    const cap = Number(config.json?.renderCapFeatures ?? 0);
    if (!Number.isFinite(cap) || cap > 20_000) {
      console.log(
        `  \x1b[33m·\x1b[0m tiled-rendering section skipped (render cap ${cap.toLocaleString()} — set DEZFIL_RENDER_CAP_FEATURES ≤ 20000 to exercise it)`,
      );
    } else {
      const rows = ["id,kind,lon,lat"];
      const count = cap + 500;
      for (let i = 0; i < count; i++) {
        // Deterministic spread around Berlin, no randomness needed.
        const lon = 13.1 + (i % 800) * 0.001;
        const lat = 52.3 + Math.floor(i / 800) * 0.01;
        rows.push(`${i},k${i % 4},${lon.toFixed(4)},${lat.toFixed(4)}`);
      }
      const form = new FormData();
      form.append("file", new Blob([rows.join("\n")]), "journey_tiles.csv");
      const up = await api("POST", "/api/tables", { form });
      if (up.status !== 201) fail("tiles: upload failed", JSON.stringify(up.json));
      const tilesTable = up.json.name;

      const tmap = await api("POST", "/api/maps", { body: { name: "Tiled journey" } });
      const tlayer = await api("POST", `/api/maps/${tmap.json.id}/layers`, {
        body: { name: "Everything", sql: `SELECT id, kind, geometry FROM ${tilesTable}` },
      });
      if (tlayer.status !== 201) fail("tiles: layer failed", JSON.stringify(tlayer.json));
      const tid = tlayer.json.id;

      // over-cap → tiled response, preparing or already ready
      let render = await api("GET", `/api/layers/${tid}/render`);
      if (render.json?.ok !== true || render.json?.mode !== "tiled")
        fail("tiles: over-cap layer did not switch to tiles", JSON.stringify(render.json));
      ok(`over-cap layer (${count.toLocaleString()} > cap ${cap.toLocaleString()}) answers tiled`);

      // poll until the archive is ready
      const deadline = Date.now() + 120_000;
      while (render.json?.tiles?.state === "building") {
        if (Date.now() > deadline) fail("tiles: build did not finish in 120s");
        await new Promise((r) => setTimeout(r, 1000));
        render = await api("GET", `/api/layers/${tid}/render`);
      }
      const tiles = render.json?.tiles;
      if (
        render.json?.ok !== true ||
        tiles?.state !== "ready" ||
        !tiles?.url?.includes("{z}") ||
        !Array.isArray(tiles?.bounds)
      )
        fail("tiles: ready state incomplete", JSON.stringify(render.json));
      ok("tiles prepared in the background: URL template, bounds, zoom range");

      // a covered tile serves MVT bytes through the documented endpoint
      const z = Math.min(tiles.maxZoom ?? 5, 8);
      const cx = (tiles.bounds[0] + tiles.bounds[2]) / 2;
      const cy = (tiles.bounds[1] + tiles.bounds[3]) / 2;
      const tx = Math.floor(((cx + 180) / 360) * 2 ** z);
      const ty = Math.floor(
        ((1 -
          Math.log(Math.tan((cy * Math.PI) / 180) + 1 / Math.cos((cy * Math.PI) / 180)) /
            Math.PI) /
          2) *
          2 ** z,
      );
      const tileUrl = tiles.url
        .replace("{z}", z)
        .replace("{x}", tx)
        .replace("{y}", ty);
      const tile = await api("GET", tileUrl, { raw: true });
      const bytes = (await tile.arrayBuffer()).byteLength;
      if (tile.status !== 200 || bytes === 0)
        fail("tiles: covered tile did not serve", `status ${tile.status}, ${bytes} bytes`);
      ok(`covered tile serves MVT (${bytes.toLocaleString()} bytes at ${z}/${tx}/${ty})`);

      // a filter under the cap returns to inline with no wait — and back
      const filtered = await api("PATCH", `/api/layers/${tid}`, {
        body: { filters: [{ field: "kind", kind: "values", values: ["k0"] }] },
      });
      if (filtered.status !== 200) fail("tiles: filter refused", JSON.stringify(filtered.json));
      const inline = await api("GET", `/api/layers/${tid}/render`);
      if (inline.json?.mode !== "inline")
        fail("tiles: under-cap filter did not return to inline", JSON.stringify(inline.json?.mode));
      await api("PATCH", `/api/layers/${tid}`, { body: { filters: [] } });
      const back = await api("GET", `/api/layers/${tid}/render`);
      if (back.json?.mode !== "tiled" || back.json?.tiles?.state !== "ready")
        fail("tiles: clearing the filter did not restore ready tiles", JSON.stringify(back.json));
      ok("filter under the cap → inline instantly; cleared → tiles, no rebuild");

      // published view rewrites the tile URL to the token scope and serves it
      const pub = await api("POST", `/api/maps/${tmap.json.id}/publish`);
      const view = await api("GET", `/api/published/${pub.json.token}`);
      const publishedLayer = view.json?.layers?.find((l) => l.id === tid);
      const pubTiles = publishedLayer?.render?.tiles;
      if (
        !pubTiles?.url?.startsWith(`/api/published/${pub.json.token}/tiles/${tid}/`)
      )
        fail("tiles: published view lacks the token-scoped tile URL", JSON.stringify(pubTiles));
      const pubTile = await api(
        "GET",
        pubTiles.url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty),
        { raw: true },
      );
      if (pubTile.status !== 200)
        fail("tiles: published tile did not serve", `status ${pubTile.status}`);
      ok("published view serves the same tiles under its token");

      // Adding a live filter re-fingerprints: its field must
      // reach the wire, so the archive rebuilds once…
      const liveFiltered = await api("PATCH", `/api/layers/${tid}`, {
        body: { filters: [{ field: "id", kind: "range", min: 1, max: cap }] },
      });
      if (liveFiltered.status !== 200)
        fail("tiles: live filter refused", JSON.stringify(liveFiltered.json));
      let liveView = await api("GET", `/api/published/${pub.json.token}`);
      let liveTiles = liveView.json?.layers?.find((l) => l.id === tid)?.render?.tiles;
      const liveDeadline = Date.now() + 120_000;
      while (liveTiles?.state === "building") {
        if (Date.now() > liveDeadline) fail("tiles: live-filter rebuild did not finish in 120s");
        await new Promise((r) => setTimeout(r, 1000));
        liveView = await api("GET", `/api/published/${pub.json.token}`);
        liveTiles = liveView.json?.layers?.find((l) => l.id === tid)?.render?.tiles;
      }
      if (liveTiles?.state !== "ready")
        fail("tiles: live-filter rebuild did not settle", JSON.stringify(liveTiles));
      // …and moving the filter's bounds never rebuilds:
      // paint and slider values stay outside the fingerprint.
      const moved = await api("PATCH", `/api/layers/${tid}`, {
        body: { filters: [{ field: "id", kind: "range", min: 2, max: cap - 1 }] },
      });
      if (moved.status !== 200)
        fail("tiles: bound move refused", JSON.stringify(moved.json));
      const movedView = await api("GET", `/api/published/${pub.json.token}`);
      const movedTiles = movedView.json?.layers?.find((l) => l.id === tid)?.render?.tiles;
      const movedTile = await api(
        "GET",
        movedTiles?.url?.replace("{z}", z).replace("{x}", tx).replace("{y}", ty) ?? tileUrl,
        { raw: true },
      );
      if (movedTiles?.state !== "ready" || movedTiles?.builtAt !== liveTiles.builtAt || movedTile.status !== 200)
        fail("tiles: a bound move retired or rebuilt the current artifact", JSON.stringify(movedTiles));
      await api("PATCH", `/api/layers/${tid}`, { body: { filters: [] } });
      ok("live-filter add rebuilds once for its wire field; bound moves keep the artifact");

      // A server-applied filter changes the shipped result immediately. The
      // old published URL cannot expose its previous, broader archive while
      // the newly inline view is current.
      const narrowed = await api("PATCH", `/api/layers/${tid}`, {
        body: { filters: [{ field: "kind", kind: "values", values: ["k0"] }] },
      });
      if (narrowed.status !== 200)
        fail("tiles: server filter refused", JSON.stringify(narrowed.json));
      const narrowedView = await api("GET", `/api/published/${pub.json.token}`);
      const narrowedRender = narrowedView.json?.layers?.find((l) => l.id === tid)?.render;
      const staleTile = await api(
        "GET",
        pubTiles.url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty),
        { raw: true },
      );
      if (narrowedRender?.mode !== "inline" || staleTile.status !== 404)
        fail("tiles: superseded published archive remained accessible", `mode ${narrowedRender?.mode}, status ${staleTile.status}`);
      await api("PATCH", `/api/layers/${tid}`, { body: { filters: [] } });
      ok("server-result cutoff hides old published tiles and renders inline");

      // unpublish severs tile access immediately
      await api("DELETE", `/api/maps/${tmap.json.id}/publish`, { raw: true });
      const severed = await api(
        "GET",
        pubTiles.url.replace("{z}", z).replace("{x}", tx).replace("{y}", ty),
        { raw: true },
      );
      if (severed.status !== 404)
        fail("tiles: unpublish did not sever tile access", `status ${severed.status}`);
      ok("unpublish severs tile access immediately");

      // deleting the layer removes its archive; the tile endpoint 404s
      await api("DELETE", `/api/layers/${tid}`, { raw: true });
      const goneTile = await api("GET", tileUrl, { raw: true });
      if (goneTile.status !== 404)
        fail("tiles: deleted layer still serves tiles", `status ${goneTile.status}`);
      await api("DELETE", `/api/maps/${tmap.json.id}`, { raw: true });
      await api("DELETE", `/api/tables/${tilesTable}`, { raw: true });
      ok("deleting the layer removes its tiles; journey artifacts cleaned up");
    }
  }

  // 13. publish the map
  let token;
  {
    const r = await api("POST", `/api/maps/${mapId}/publish`);
    if (r.status !== 201 || !r.json?.token)
      fail("publish failed", JSON.stringify(r.json));
    token = r.json.token;
    ok(`published → token ${token.slice(0, 6)}…`);
  }

  // 14. the published view resolves, carries the map surface, and is read-only
  {
    const r = await api("GET", `/api/published/${token}`);
    if (r.status !== 200 || r.json?.layers?.length !== 3)
      fail("published view did not resolve", JSON.stringify(r.json));
    if (!String(r.json?.basemapUrl).includes("positron"))
      fail("published view ignores the basemap choice", r.json?.basemapUrl);
    const published = r.json.layers[0];
    if (published.tooltip === undefined || published.inLegend === undefined)
      fail("published layers lack tooltip/legend fields", JSON.stringify(published));
    ok("published view resolves with basemap, tooltip, and legend state");

    // The aggregated layer arrives ready to draw — its style fill IS
    // the cell fill, its render is cells, and its legend text is carried.
    const hexed = r.json.layers.find((l) => l.viz?.type === "hexbin");
    if (
      !hexed ||
      hexed.style?.fill?.type !== "quantile" ||
      hexed.style?.fill?.attribute !== "value" ||
      hexed.legendTitle !== "Stations by traffic" ||
      hexed.legendAttrs?.fill !== "Traffic" ||
      hexed.render?.geojson?.features?.[0]?.properties?.count === undefined
    )
      fail("published view lacks the effective aggregated state", JSON.stringify(hexed?.style));
    const heat = r.json.layers.find((l) => l.viz?.type === "heatmap");
    if (!heat || heat.viz?.radiusPx !== 40)
      fail("published view lacks the heatmap viz", JSON.stringify(heat?.viz));
    ok("published view carries effective cell fills, viz configs, and legend text");

    // The data-driven channels arrive on the published style, read-only.
    const copy = r.json.layers.find((l) => l.name === "All stations copy");
    if (
      copy?.style?.strokeBy?.type !== "categorical" ||
      copy?.style?.pointRadiusBy?.attribute !== "riders" ||
      copy?.style?.fill?.method !== "natural" ||
      copy?.style?.fill?.colors?.[0]?.r !== 1
    )
      fail("published view lacks the data-driven channels", JSON.stringify(copy?.style));
    ok("published view carries outline, size, and edited-color channels");

    // No mutating verb is exposed on the public path.
    const mutate = await api("DELETE", `/api/published/${token}`, { raw: true });
    if (![401, 404, 405].includes(mutate.status))
      fail("public path exposed a mutation", `status ${mutate.status}`);
    ok("public path refuses mutation");
  }

  // 14b. the published projection: the wire carries exactly
  // what the shared-fields statement states, in both modes.
  {
    const wireKeys = async (id) => {
      const view = await api("GET", `/api/published/${token}`);
      const layer = view.json?.layers?.find((l) => l.id === id);
      const feature = layer?.render?.geojson?.features?.[0];
      if (!feature)
        fail("published layer has no inline features", JSON.stringify(layer?.render));
      return Object.keys(feature.properties)
        .filter((k) => k !== "__anchor")
        .sort();
    };
    const stated = async (id) => {
      const r = await api("GET", `/api/maps/${mapId}/published-fields`);
      const entry = r.json?.layers?.find((l) => l.layerId === id);
      if (!entry?.fields)
        fail("shared-fields statement missing", JSON.stringify(r.json));
      return { mode: entry.mode, names: entry.fields.map((f) => f.name).sort() };
    };

    // The plain points layer — the aggregated layers already publish only
    // their computed columns, so the projection story lives here.
    const m = await api("GET", `/api/maps/${mapId}`);
    const pointsId = m.json?.layers?.find(
      (l) => l.name === "All stations copy",
    )?.id;
    if (!pointsId) fail("points layer not found", JSON.stringify(m.json?.layers));

    const derived = await stated(pointsId);
    const derivedWire = await wireKeys(pointsId);
    if (
      derived.mode !== "derived" ||
      JSON.stringify(derivedWire) !== JSON.stringify(derived.names)
    )
      fail(
        "derived statement and wire disagree",
        `wire ${derivedWire} vs stated ${derived.names}`,
      );

    const set = await api("PATCH", `/api/layers/${pointsId}`, {
      body: { publishedFields: ["riders"] },
    });
    if (
      set.status !== 200 ||
      JSON.stringify(set.json?.publishedFields) !== JSON.stringify(["riders"])
    )
      fail("override did not round-trip", JSON.stringify(set.json));
    const listed = await stated(pointsId);
    const listedWire = await wireKeys(pointsId);
    if (
      listed.mode !== "list" ||
      JSON.stringify(listedWire) !== JSON.stringify(listed.names)
    )
      fail(
        "override statement and wire disagree",
        `wire ${listedWire} vs stated ${listed.names}`,
      );
    if (listedWire.length >= derivedWire.length)
      fail(
        "the override did not narrow the wire",
        `derived ${derivedWire} vs listed ${listedWire}`,
      );

    const cleared = await api("PATCH", `/api/layers/${pointsId}`, {
      body: { publishedFields: null },
    });
    if (cleared.status !== 200 || cleared.json?.publishedFields !== null)
      fail("clearing the override failed", JSON.stringify(cleared.json));
    ok("published wire equals the shared-fields statement in both modes");
  }

  // 15. republish returns the same token; unpublish stops resolution
  {
    const again = await api("POST", `/api/maps/${mapId}/publish`);
    if (again.json?.token !== token)
      fail("republish changed the token", JSON.stringify(again.json));
    const un = await api("DELETE", `/api/maps/${mapId}/publish`, { raw: true });
    if (un.status !== 204) fail("unpublish failed", `status ${un.status}`);
    const gone = await api("GET", `/api/published/${token}`);
    if (gone.status !== 404)
      fail("unpublished link still resolves", JSON.stringify(gone.json));
    ok("republish is idempotent; unpublish revokes immediately");
  }

  // ── draw on the map — sketches are data, end to end ──────────
  {
    const settle = async (runId, what) => {
      for (let i = 0; i < 120; i++) {
        const polled = await api("GET", `/api/operations/runs/${runId}`);
        const state = polled.json?.run?.state;
        if (state === "succeeded") return polled.json.run;
        if (state === "failed")
          fail(`${what} failed`, JSON.stringify(polled.json));
        await new Promise((r) => setTimeout(r, 500));
      }
      fail(`${what} never settled`);
    };
    const square = {
      kind: "polygon",
      geometry: {
        type: "Polygon",
        coordinates: [[[13.0, 52.0], [13.2, 52.0], [13.2, 52.2], [13.0, 52.2], [13.0, 52.0]]],
      },
    };

    const madeMap = await api("POST", "/api/maps", { body: { name: "Sketch journey" } });
    if (madeMap.status !== 201 && madeMap.status !== 200)
      fail("map creation failed", JSON.stringify(madeMap.json));
    const mapId = madeMap.json.id;

    // First commit mints dataset + owning layer together, named from the map.
    const first = await api("POST", `/api/maps/${mapId}/sketches`, {
      body: { feature: square },
    });
    if (first.status !== 201 || first.json?.table !== "sketch_journey_sketch")
      fail("first commit did not mint the named sketch", JSON.stringify(first.json));
    const sk1 = first.json;
    const reg = (await api("GET", "/api/tables")).json.find((t) => t.name === sk1.table);
    if (reg?.source !== "sketch" || reg?.sourceParams?.mapId !== mapId || reg?.sourceParams?.layerId !== sk1.layerId)
      fail("sketch provenance does not name its drawn origin and owner", JSON.stringify(reg));
    const layers1 = (await api("GET", `/api/maps/${mapId}/layers`)).json;
    const owner = layers1.find((l) => l.id === sk1.layerId);
    if (!owner || owner.name !== "Sketch" || !(owner.style?.strokeWidth > 0))
      fail("the owning layer is missing or its all-families style is not explicit", JSON.stringify(owner));

    // Mixed kinds join the same dataset; identity holds; the class is composite.
    const point = { kind: "point", geometry: { type: "Point", coordinates: [13.1, 52.1] } };
    const line = {
      kind: "line",
      geometry: { type: "LineString", coordinates: [[13.05, 52.05], [13.15, 52.15]] },
    };
    const ap = await api("POST", `/api/sketches/${sk1.table}/features`, { body: { feature: point } });
    const al = await api("POST", `/api/sketches/${sk1.table}/features`, { body: { feature: line } });
    if (ap.status !== 201 || al.status !== 201 || al.json.rowCount !== 3)
      fail("appends did not land as rows", JSON.stringify({ ap: ap.json, al: al.json }));
    const mixed = (await api("GET", "/api/tables")).json.find((t) => t.name === sk1.table);
    if (mixed.id !== reg.id)
      fail("a mutation changed the dataset's identity", `${reg.id} -> ${mixed.id}`);
    for (const family of ["POINT", "LINESTRING", "POLYGON"])
      if (!String(mixed.geometryType).includes(family))
        fail("the mixed class lost a family", String(mixed.geometryType));

    // The features read carries stable ids and kinds.
    const feats = (await api("GET", `/api/sketches/${sk1.table}/features`)).json.features;
    if (feats.length !== 3 || feats.some((f) => !f.id || !f.kind))
      fail("the features read lost ids or kinds", JSON.stringify(feats));
    const polyFeat = feats.find((f) => f.kind === "polygon");

    // The one permitted edit: one vertex moves; kind and count hold.
    const mv = await api("PATCH", `/api/sketches/${sk1.table}/features/${polyFeat.id}`, {
      body: { vertexIndex: 1, position: [13.3, 52.0] },
    });
    if (mv.status !== 200) fail("the vertex move was refused", JSON.stringify(mv.json));
    const moved = (await api("GET", `/api/sketches/${sk1.table}/features`)).json.features.find(
      (f) => f.id === polyFeat.id,
    );
    const ring = moved.geometry.coordinates[0];
    if (ring.length !== 5 || ring[1][0] !== 13.3)
      fail("the moved ring is not the drawn ring", JSON.stringify(ring));
    const lineFeat = feats.find((f) => f.kind === "line");
    const badMove = await api("PATCH", `/api/sketches/${sk1.table}/features/${lineFeat.id}`, {
      body: { vertexIndex: 0, position: [13.0, 52.0] },
    });
    if (badMove.status !== 409)
      fail("a line accepted a vertex move", JSON.stringify(badMove.json));

    // The published ceiling refuses at the API exactly as in the UI.
    const hugeRing = [];
    for (let i = 0; i < 10_001; i++) hugeRing.push([13 + i / 1e6, 52]);
    hugeRing.push([13, 52]);
    const tooBig = await api("POST", `/api/sketches/${sk1.table}/features`, {
      body: { feature: { kind: "freehand", geometry: { type: "Polygon", coordinates: [hugeRing] } } },
    });
    const afterRefusal = (await api("GET", "/api/tables")).json.find((t) => t.name === sk1.table);
    if (tooBig.status !== 400 || afterRefusal.rowCount !== 3)
      fail("the vertex ceiling did not refuse cleanly", JSON.stringify(tooBig.json));

    // Deleting one shape deletes exactly its row.
    const del = await api("DELETE", `/api/sketches/${sk1.table}/features/${lineFeat.id}`);
    if (del.status !== 200 || del.json.rowCount !== 2)
      fail("the feature delete did not remove one row", JSON.stringify(del.json));

    // A second session advances the suffix; its points feed the filter test.
    const mk = (lng, lat) => ({ kind: "point", geometry: { type: "Point", coordinates: [lng, lat] } });
    const second = await api("POST", `/api/maps/${mapId}/sketches`, { body: { feature: mk(13.05, 52.05) } });
    if (second.status !== 201 || second.json.table !== "sketch_journey_sketch_2" || second.json.layerName !== "Sketch 2")
      fail("the collision did not advance visibly", JSON.stringify(second.json));
    const sk2 = second.json;
    await api("POST", `/api/sketches/${sk2.table}/features`, { body: { feature: mk(13.15, 52.1) } });
    await api("POST", `/api/sketches/${sk2.table}/features`, { body: { feature: mk(14.5, 53.5) } });

    // The map-scoped read groups both with per-kind counts.
    const summaries = (await api("GET", `/api/maps/${mapId}/sketches`)).json;
    if (summaries.length !== 2 || summaries.find((s) => s.table === sk2.table)?.counts?.point !== 3)
      fail("the sketch summaries are not honest", JSON.stringify(summaries));

    // A drawn polygon drives Filter by location through the unchanged
    // one-step surface — with a drawn mask AND drawn input.
    const filterRun = await api("POST", "/api/operations/run", {
      body: {
        operation: "filter_by_location",
        parameters: {
          input: sk2.table,
          mask: sk1.table,
          relation: "within",
          name: "sketch_journey_kept",
        },
      },
    });
    if (filterRun.status !== 202)
      fail("the sketch-fed tool run was not accepted", JSON.stringify(filterRun.json));
    await settle(filterRun.json.run.id, "filter by location over sketches");
    const kept = (await api("GET", "/api/tables")).json.find((t) => t.name === "sketch_journey_kept");
    if (kept?.rowCount !== 2)
      fail("the drawn mask did not filter the drawn points", JSON.stringify(kept));

    // The cascade: owner layer + dataset + artifact leave together; the
    // other sketch, the tool output and history stay.
    const cascade = await api("DELETE", `/api/sketches/${sk1.table}`);
    if (cascade.status !== 204) fail("the cascade was refused", JSON.stringify(cascade.json));
    const goneTable = await api("GET", `/api/tables/${sk1.table}`);
    if (goneTable.status !== 404)
      fail("the cascaded dataset still answers", JSON.stringify(goneTable.json));
    const layersAfter = (await api("GET", `/api/maps/${mapId}/layers`)).json;
    if (layersAfter.some((l) => l.id === sk1.layerId))
      fail("the cascaded owner layer survived");
    if (!layersAfter.some((l) => l.id === sk2.layerId))
      fail("the cascade touched another sketch's layer");
    const keptAfter = await api("GET", `/api/tables/sketch_journey_kept`);
    if (keptAfter.status !== 200)
      fail("the cascade destroyed a materialized tool output", JSON.stringify(keptAfter.json));
    const hist = await api("GET", `/api/maps/${mapId}/history`);
    if (hist.status !== 200)
      fail("history did not survive the cascade", JSON.stringify(hist.json));
    ok("sketches are data end to end: mint, mixed rows, vertex move, ceiling, filter, cascade");
  }


  // The image-export step stays last: it needs a provisioned renderer
  // (DEZFIL_CHROMIUM_PATH), and a render-farm provisioning gap must
  // never mask the data sections above.
  // 15b. projects (before the renderer-dependent export, which stays last): the optional named set
  {
    const created = await api("POST", "/api/projects", {
      body: { name: "Journey study" },
    });
    if (created.status !== 201 || typeof created.json?.id !== "string")
      fail("project creation refused", JSON.stringify(created.json));
    const pid = created.json.id;

    // A map created inside it is a member at birth, and the listing scopes.
    const filed = await api("POST", "/api/maps", {
      body: { name: "Journey filed map", projectId: pid },
    });
    if (filed.status !== 201 || filed.json?.projectId !== pid)
      fail("map not filed at birth", JSON.stringify(filed.json));
    const scoped = await api("GET", `/api/maps?project=${pid}`);
    if (!scoped.json?.some((m) => m.id === filed.json.id) || scoped.json.length !== 1)
      fail("scoped maps listing wrong", JSON.stringify(scoped.json?.length));
    ok("projects: a map files at birth and the listing scopes");

    // An upload with the context lands as a member in the same act.
    const form = new FormData();
    form.append(
      "file",
      new Blob(["name,lon,lat\np,13.4,52.5\n"]),
      "journey_project_points.csv",
    );
    const up = await api("POST", `/api/tables?project=${pid}`, { form });
    if (up.status !== 201)
      fail("upload with project context refused", JSON.stringify(up.json));
    const scopedTables = await api("GET", `/api/tables?project=${pid}`);
    const member = scopedTables.json?.find(
      (t) => t.name === "journey_project_points",
    );
    if (!member || !Array.isArray(member.projectIds) || !member.projectIds.includes(pid))
      fail("uploaded dataset not a member", JSON.stringify(member));
    ok("projects: an upload joins the project atomically");

    // The composite members read answers the ordinary listing shapes, and
    // the project listing's counts reflect the membership.
    const members = await api("GET", `/api/projects/${pid}/members`);
    if (
      members.json?.maps?.length !== 1 ||
      members.json?.tables?.length !== 1 ||
      !Array.isArray(members.json?.recipes)
    )
      fail("composite members read wrong", JSON.stringify(members.json && Object.keys(members.json)));
    const listed = await api("GET", "/api/projects");
    const mine = listed.json?.find((p) => p.id === pid);
    if (mine?.mapCount !== 1 || mine?.tableCount !== 1 || mine?.sizeComplete !== true)
      fail("project counts wrong", JSON.stringify(mine));

    // An unknown scope refuses; it never reads as an empty project.
    const unknown = await api("GET", "/api/maps?project=journey-nowhere");
    if (unknown.status !== 404)
      fail("unknown project scope did not refuse", String(unknown.status));
    ok("projects: counts, members and the unknown-scope refusal");

    // Deletion dissolves: the disclosure says so and every member remains.
    const gone = await api("DELETE", `/api/projects/${pid}`);
    if (gone.status !== 200 || gone.json?.contentsRemain !== true)
      fail("dissolution disclosure missing", JSON.stringify(gone.json));
    const after = await api("GET", "/api/maps");
    const survivor = after.json?.find((m) => m.id === filed.json.id);
    if (!survivor || survivor.projectId !== null)
      fail("dissolution touched a member", JSON.stringify(survivor));
    ok("projects: dissolution leaves every member, unfiled");
  }

  // 16. server-side image export: a real render through the
  // instance's own browser, proven by pixels — dimensions exact, data
  // actually colored. The map is unpublished here (step 15), so this is
  // also the private-road proof. Fails coded when the browser is absent
  // (the derived-image negative depends on exactly that).
  if (!process.argv.includes("--http-only")) {
    const definition = {
      viewport: { lng: 13.4, lat: 52.51, zoom: 10, pitch: 0, bearing: 0 },
      size: { width: 640, height: 360 },
      legend: { visible: true, corner: "bottom-left", size: "m" },
      widgets: [],
      title: { text: "Journey export", size: "m" },
      appearance: "light",
      overlayScale: 2,
    };
    const fixture = await startLoopbackBasemap();
    try {
      // All public-basemap persistence checks have already run. This style
      // and its tiles now live beside the renderer, including in a container.
      const patched = await api("PATCH", `/api/maps/${mapId}`, {
        body: { customBasemap: { url: fixture.styleUrl, name: "Journey fixture", force: true } },
      });
      if (patched.status !== 200)
        throw new Error(`fixture basemap was not saved: ${JSON.stringify(patched.json)}`);
      const before = fixture.snapshot(definition.viewport.zoom);
      const r = await api("POST", `/api/maps/${mapId}/export/image`, {
        body: { definition },
        raw: true,
      });
      const traffic = fixture.delta(before, definition.viewport.zoom);
      console.log(`journey export ${JSON.stringify({ status: r.status, ...traffic })}`);
      if (r.status === 200) {
        assertBasemapTraffic(traffic);
        if (r.headers.has("x-dezfil-export-abandoned"))
          throw new Error("ordinary export abandoned a basemap request");
      }
      if (r.status !== 200) {
        const detail = await r.text();
        fail("image export did not answer 200", `${r.status} ${detail}`);
      }
      const png = Buffer.from(await r.arrayBuffer());
      let img;
      try {
        img = decodePng(png);
      } catch (e) {
        fail("the export is not a decodable PNG", String(e));
      }
      if (img.width !== 640 || img.height !== 360)
        fail(
          "export dimensions are not the definition's",
          `${img.width}×${img.height}`,
        );
      const colored = countColored(img);
      if (colored < 200)
        fail(
          "the export carries no data pixels (blank or basemap-only render)",
          `colored=${colored}`,
        );
      ok(`server image export renders real pixels (colored=${colored})`);
    } finally {
      await fixture.close();
    }
  } else {
    console.log("NOT RUN: server image export (--http-only). The default journey still requires a real renderer.");
  }

  console.log(`\n\x1b[32mJourney complete — ${step} steps passed.\x1b[0m\n`);
}

main().catch((e) => fail("unexpected error", e?.stack ?? String(e)));
