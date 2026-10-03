"use client";

import { useEffect, useRef, useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { Layer } from "@/lib/metadata/maps";
import { FaceBody, FaceHeader, type FaceMark } from "./FaceHeader";
import { OperationPicker } from "./OperationPicker";
import { ParameterForm, type AuthoredStep } from "./ParameterForm";
import { SuccessFace, type RunSuccess } from "./SuccessFace";
import { geometryClassOf } from "./derived-tables";
import { suggestedOperations, tablesNamedIn } from "./operation-form";
import type { RecipeSummary } from "./recipe-model";
import type { AuthorStepPort } from "./use-author-step";
import { useOperations } from "./use-operations";
import type { RecipeDrawerState } from "./use-recipe-drawer";
import type { RecipesPort } from "./use-recipes";
import type { WorkspaceTablesPort } from "./use-workspace-tables";

/**
 * What is inside the drawer, and which of its three faces is showing.
 *
 * The three are the catalog, a tool's form, and a finished run's success
 * face — with the catalog as the opening face from both doors, suggestions
 * first from the layer door. They are **exclusive by construction** rather
 * than by careful hiding, so two of them cannot both be true. The chain
 * face left with the one-step pivot; the invisible recipe underneath is
 * machinery, and nothing here renders it.
 *
 * **Dismissing never confirms.** No unsaved-edit guard exists anywhere in
 * this module: a drawer a user cannot leave without losing work is a panel
 * with a different shape, and the guardrail's first part says so.
 */
type Face =
  | { kind: "picking" }
  | { kind: "authoring"; operation: OperationDef }
  | { kind: "success"; made: RunSuccess; mark?: FaceMark };

/** The glyph the header draws before a tool's name: the catalog's
 * own mark for the operation, in its group's hue. */
const markOf = (operation: OperationDef): FaceMark => ({
  symbol: operation.symbol,
  group: operation.group,
});

export function DrawerContents({
  state,
  recipe,
  recipes,
  tables,
  mapId,
  authoring,
  layers,
  onFreshAction,
  onDone,
  onLayerMade,
}: {
  state: RecipeDrawerState;
  recipe: RecipeSummary | undefined;
  recipes: RecipesPort;
  tables: WorkspaceTablesPort;
  /** The map being built — the sketches group needs it. */
  mapId?: string | null;
  /** Authoring lives above this component so the host's settle sees it. */
  authoring: AuthorStepPort;
  layers: Layer[];
  /** Start a fresh action — the success face's Run another tool. */
  onFreshAction?: () => void;
  /** The drawer's own dismissal — the success face's Done, and the
   * catalog's cancel: the catalog is the base face, so backing out of it
   * is leaving the drawer. */
  onDone?: () => void;
  /** A run created this layer; the builder selects it. */
  onLayerMade?: (layerId: string) => void;
}) {
  const [face, setFace] = useState<Face>({ kind: "picking" });
  const { operations, error: catalogError } = useOperations();
  // **A completion may not outlive its session**: the contents
  // are keyed by the authoring session, so an unmount IS a session change —
  // and a late run settling after it must touch nothing. The old guard
  // compared against a captured recipeId, which for a first run was null
  // and stayed null in the closure; binding through it could append the
  // old recipe's step count from inside a brand-new action.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const originLayer = layers.find((l) => l.id === state.originLayerId) ?? null;

  /** What the door arrived from, so the catalog can lead with verbs that fit
   * the data rather than a list that ignores it. */
  const origin = (() => {
    const named = originLayer
      ? tablesNamedIn(originLayer.sql, tables.tables ?? [])
      : [];
    return named.length === 1
      ? { table: named[0].name, geometry: geometryClassOf(named[0]) }
      : null;
  })();

  const run = (step: AuthoredStep) => {
    const target = state.recipeId;
    // The face is the form's when Run is pressed; its operation names the
    // success header. Captured now — the completion outlives the render.
    const toolLabel = face.kind === "authoring" ? face.operation.label : "Tools";
    const toolMark = face.kind === "authoring" ? markOf(face.operation) : undefined;
    void authoring
      .author({
        recipeId: recipe?.id ?? target,
        recipe,
        recipeName: originLayer ? `Analysis of ${originLayer.name}` : "Recipe",
        step,
        // Bound as soon as it exists, so a failure and a retry join the same
        // recipe instead of leaving an orphan behind.
        onRecipe: state.bindRecipe,
      })
      .then((outcome) => {
        if (!outcome) return;
        // Only while this session is still the mounted one — the key
        // remounts on every new action, so a stale completion finds
        // `mounted` false and leaves the world alone. The workspace reload
        // in the hook's own settle still delivers the result's layer.
        if (!mounted.current) return;
        if (state.recipeId !== null && state.recipeId !== outcome.recipeId) return;
        state.bindRecipe(outcome.recipeId);
        if (outcome.layerId) onLayerMade?.(outcome.layerId);
        setFace({
          kind: "success",
          mark: toolMark,
          made: {
            tool: toolLabel,
            table: outcome.output?.name ?? "",
            rows: outcome.rows,
            geometryType: outcome.geometryType,
            spatial: outcome.spatial,
            layerName: outcome.layerName,
            notice: outcome.notice ?? "",
          },
        });
      });
  };

  if (face.kind === "success") {
    return (
      <>
        <FaceHeader title={face.made.tool} mark={face.mark} onDismiss={() => onDone?.()} />
        <FaceBody>
          <SuccessFace
            made={face.made}
            onRunAnother={() => onFreshAction?.()}
            onDone={() => onDone?.()}
          />
        </FaceBody>
      </>
    );
  }

  if (face.kind === "authoring") {
    return (
      <>
        <FaceHeader
          title={face.operation.label}
          mark={markOf(face.operation)}
          onBack={() => {
            authoring.clearError();
            setFace({ kind: "picking" });
          }}
          onDismiss={() => onDone?.()}
        />
        <FaceBody>
          <ParameterForm
        operation={face.operation}
        tables={tables.tables ?? []}
        recipes={recipes.recipes ?? []}
        mapId={mapId}
        originLayer={
          originLayer
            ? {
                id: originLayer.id,
                name: originLayer.name,
                sql: originLayer.sql,
                filters: originLayer.filters,
              }
            : null
        }
            busy={authoring.busy}
            error={authoring.error}
            onRun={run}
          />
        </FaceBody>
      </>
    );
  }

  return (
    <>
      <FaceHeader title="Tools" onDismiss={() => onDone?.()} />
      <FaceBody>
        <OperationPicker
        operations={operations}
        error={catalogError ?? tables.error}
        suggestions={suggestedOperations(operations ?? [], origin?.geometry ?? null)}
        suggestedFor={origin?.table ?? null}
          onPick={(operation) => setFace({ kind: "authoring", operation })}
        />
      </FaceBody>
    </>
  );
}

/** What the door pre-fills, exported for the tests that assert it. */
export { tablesNamedIn };
