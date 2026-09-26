"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError } from "../../api";
import type { RecipeSummary } from "./recipe-model";

/**
 * The workspace's recipes, as the index and the drawer read them.
 *
 * **Every call here is one published.** The index's create, rename, duplicate
 * and delete left with the one-step pivot — recipes are machinery now, and
 * the API keeps those capabilities for agents; nothing in the builder calls
 * them.
 */

export interface RecipesPort {
  recipes: RecipeSummary[] | null;
  error: string | null;
  reload: () => void;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

export function useRecipes(): RecipesPort {
  const [answer, setAnswer] = useState<{
    recipes: RecipeSummary[] | null;
    error: string | null;
  }>({ recipes: null, error: null });
  // A reload is a new attempt: the effect keys on the number, so the load it
  // replaces is abandoned rather than allowed to land last.
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const { recipes, error } = answer;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { recipes: loaded } = await readJson<{ recipes: RecipeSummary[] }>(
          await fetch("/api/recipes"),
        );
        if (!cancelled) setAnswer({ recipes: loaded, error: null });
      } catch (e) {
        if (cancelled) return;
        setAnswer({
          recipes: [],
          error: e instanceof Error ? e.message : "Could not load recipes.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { recipes, error, reload };
}
