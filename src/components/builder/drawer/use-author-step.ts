"use client";

import { useCallback, useRef, useState } from "react";
import { editHeaders } from "@/lib/edit-basis";
import { useEditorRequest } from "../../document-editor-context";
import type { RecipeSummary } from "./recipe-model";
import { readApiError, type TableListing } from "../../api";
import type { AuthoredStep } from "./ParameterForm";
import { pollUntilTerminal } from "./poll";

/**
 * Authoring a step and running it — the headline deliverable.
 *
 * **Nothing is created until Run.** A user who opens the door, reads the form
 * and leaves adds nothing to the workspace: the recipe, its step and its
 * dataset all come into existence at the same gesture. That is what makes the
 * index's draft rule cheap and what makes *Analyze…* free to press.
 *
 * **Every call is one published** — create a recipe, add a
 * step, run it, poll the run, and (when asked) create a layer over the result
 * through the map's own layer route.
 */

interface RunView {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  output?: { id: string; name: string };
  error?: { code: string; message: string };
  warnings?: string[];
}

export interface AuthorOutcome {
  recipeId: string;
  stepId: string;
  output?: { id: string; name: string };
  /** The created layer, when the layer service accepted the result — carried
   * so the builder can select it. Null for a table-only result and for a
   * refused layer alike; the notice says which. */
  layerId: string | null;
  layerName: string | null;
  /** The completed table's own facts, for the success face. */
  rows: number | null;
  geometryType: string | null;
  /** Whether a geometry column exists — an empty spatial result types null
   * but is still spatial, and still a layer. */
  spatial: boolean;
  /** What the user is told afterwards — including the honest half of a result
   * that could not become a layer. */
  notice: string | null;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

export interface AuthorStepPort {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  author: (args: {
    recipeId: string | null;
    recipe?: RecipeSummary;
    recipeName: string;
    step: AuthoredStep;
    /**
     * Called the moment a recipe exists, before the step is added or run.
     *
     * **A retry after a failed step must not mint a second recipe.** Binding
     * only on success meant a refused parameter, a taken name or a failed run
     * left an orphan behind and the next attempt made another. Found at the
     * cross-model review.
     */
    onRecipe: (recipeId: string) => void;
  }) => Promise<AuthorOutcome | null>;
}

export function useAuthorStep({
  mapId,
  onSettled,
}: {
  mapId: string;
  /** Called once the workspace may have moved — a new table, a new layer. */
  onSettled: () => void;
}): AuthorStepPort {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useEditorRequest();
  const acceptedBases = useRef(new Map<string, string>());

  const author = useCallback(
    async ({
      recipeId,
      recipe,
      recipeName,
      step,
      onRecipe,
    }: {
      recipeId: string | null;
      recipe?: RecipeSummary;
      recipeName: string;
      step: AuthoredStep;
      onRecipe: (recipeId: string) => void;
    }): Promise<AuthorOutcome | null> => {
      setBusy(true);
      setError(null);
      try {
        // 1. The recipe, if this is the first run of a draft.
        let id = recipeId;
        let revision = recipe?.editRevision ?? (id ? acceptedBases.current.get(id) : undefined);
        const accept = (result: { editRevision?: string }) => {
          if (result.editRevision) {
            revision = result.editRevision;
            if (id) acceptedBases.current.set(id, revision);
          }
        };
        const headers = (initial?: HeadersInit) => revision ? editHeaders({ editRevision: revision }, initial) : new Headers(initial);
        if (id === null) {
          const created = await readJson<{ recipe: { id: string; editRevision: string } }>(
            await fetch("/api/recipes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // The builder's one-step recipes say so, which is what keeps
              // them off the workflows page.
              body: JSON.stringify({ name: recipeName, origin: "builder" }),
            }),
          );
          id = created.recipe.id;
          accept(created.recipe);
          // Bound here, not at the end: everything after this can fail, and a
          // retry must join the recipe rather than mint another.
          onRecipe(id);
        }

        // 2. The step — after sweeping the bound recipe of any step that
        // never produced output. A ref remembering the failed attempt was
        // not enough: the add-step POST can commit while
        // its response is lost, and a retry would then append beside a
        // step nothing remembers. The server's own state is the memory —
        // an unfinished one-step recipe holds at most one output-less
        // step, and the sweep deletes whatever is there before adding.
        if (recipeId !== null) {
          // This read locates unfinished work. It never replaces the basis
          // captured with the form or returned by our accepted predecessor.
          const listed = await readJson<{
            recipes: {
              id: string;
              steps: { id: string; output: unknown | null }[];
            }[];
          }>(await fetch("/api/recipes", { cache: "no-store" }));
          const bound = listed.recipes.find((r) => r.id === id);
          for (const stale of bound?.steps.filter((x) => x.output === null) ?? []) {
            const removal = await fetch(
              `/api/recipes/${encodeURIComponent(id)}/steps/${encodeURIComponent(stale.id)}`,
              { method: "DELETE", headers: headers() },
            );
            if (!removal.ok && removal.status !== 404) {
              throw new Error(await readApiError(removal));
            }
            if (removal.ok) accept(await removal.json());
          }
        }
        // A refusal here — an unknown input, a backward read, a name already
        // taken — is the API's own sentence, shown as it is.
        const addedResult = await readJson<{ step: { id: string }; editRevision: string }>(
          await fetch(`/api/recipes/${encodeURIComponent(id)}/steps`, {
            method: "POST",
            headers: headers({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              operation: step.operation,
              parameters: step.parameters,
              ...(step.fromLayerId ? { fromLayerId: step.fromLayerId } : {}),
            }),
          }),
        );
        accept(addedResult);
        const added = addedResult.step;

        // 3. Run it, and 4. wait for a terminal state. The run outlives this
        // request by design, so what happens here is polling, not awaiting.
        // A step's own run is one of the recipe's runs: its one
        // member's job is the attempt to follow.
        const { run: accepted } = await readJson<{ run: { id: string; members: { jobId: string | null }[] } }>(
          await fetch(
            `/api/recipes/${encodeURIComponent(id)}/steps/${encodeURIComponent(added.id)}/run`,
            { method: "POST", headers: headers() },
          ),
        );
        const jobId = accepted.members[0]?.jobId;
        if (!jobId) throw new Error("The run was accepted without an attempt to follow.");
        const settled = await pollUntilTerminal<RunView>({
          read: async () =>
            (
              await readJson<{ run: RunView }>(
                await fetch(`/api/operations/runs/${encodeURIComponent(jobId)}`),
              )
            ).run,
          done: (run) =>
            run.state === "succeeded" ||
            run.state === "failed" ||
            run.state === "cancelled",
        });

        if (settled.state !== "succeeded" || !settled.output) {
          throw new Error(
            settled.error?.message ??
              (settled.state === "cancelled"
                ? "The run was cancelled."
                : "The run did not finish."),
          );
        }

        // 5. The layer, wherever the layer service accepts the result
        // The *On the map* checkbox is retired: a mappable
        // result becomes a layer in the same gesture, always. **The
        // decision is the server's boundary — the geometry column, not the
        // class**: an empty spatial result types null and is still a layer
        // (the boundary's own rule), so the client offers rather than
        // pre-judging. A layer refusal never erases the dataset that was
        // written — the split outcome is reported, not swallowed.
        let notice: string | null;
        let layerId: string | null = null;
        let layerName: string | null = null;
        const table = await readJson<TableListing>(
          await fetch(`/api/tables/${encodeURIComponent(settled.output.name)}`),
        );
        if (table.geometryColumn !== null) {
          try {
            const layer = await readJson<{ id: string }>(
              await request(`/api/maps/${encodeURIComponent(mapId)}/layers`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // The output is the runner's own dataset, named as their
                // console names it; the server carries it into the map's home.
                body: JSON.stringify({
                  name: step.displayName,
                  sql: `SELECT * FROM ${settled.output.name}`,
                  writtenIn: { kind: "console" },
                }),
              }),
            );
            layerId = layer.id;
            layerName = step.displayName;
            notice = `“${step.displayName}” is on the map, reading “${settled.output.name}”.`;
          } catch (layerFailure) {
            notice =
              `“${settled.output.name}” was written, but could not become a ` +
              `layer: ${
                layerFailure instanceof Error
                  ? layerFailure.message
                  : "the layer was refused"
              }`;
          }
        } else {
          notice =
            `“${settled.output.name}” has no geometry, so it is a dataset in ` +
            `the workspace. There is nothing to draw; find it under Data.`;
        }
        if (settled.warnings?.length) {
          notice = `${notice} ${settled.warnings.join(" ")}`;
        }
        return {
          recipeId: id,
          stepId: added.id,
          output: settled.output,
          layerId,
          layerName,
          rows: typeof table.rowCount === "number" ? table.rowCount : null,
          geometryType: table.geometryType ?? null,
          spatial: table.geometryColumn !== null,
          notice,
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : "The step did not run.");
        return null;
      } finally {
        setBusy(false);
        onSettled();
      }
    },
    [mapId, onSettled, request],
  );

  return { busy, error, clearError: useCallback(() => setError(null), []), author };
}
