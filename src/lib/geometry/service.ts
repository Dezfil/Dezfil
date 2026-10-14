import { withTrustedOperation } from "@/lib/trusted-operation";
import type { AccountScope } from "@/lib/auth/scope";
import { ResultBudget, jsonBytes } from "@/lib/query/result-budget";
import { INSPECT_PREVIEW_ROWS } from "@/lib/table-preview-limit";
import { trustedH3Ready } from "@/lib/duckdb";
import { recognizeStoredContent } from "@/lib/ingest/content-recognition";
import { withBlankCoordinateFacts } from "@/lib/ingest/csv-source";
import { geometryColumns, geometryRevision, readGeometry, requireGeometryTable } from "./read";
import { getGeometryState } from "./state";
import { geometryOwnership, nativeGeometryChoice } from "./ownership";
import { inspectionCache } from "./inspection-cache";
import type { GeometryMode } from "./types";

const cachedInspection = inspectionCache<Awaited<ReturnType<typeof readInspection>>>();

export function inspectGeometry(scope: AccountScope, name: string, signal?: AbortSignal) {
  return withTrustedOperation({ kind: "interactive-read", name: "Geometry inspection", signal }, async () => {
    const table = requireGeometryTable(scope, name);
    return cachedInspection(table, () => readInspection(table));
  });
}

function readInspection(table: ReturnType<typeof requireGeometryTable>) {
  const state = getGeometryState(table);
  return readGeometry(table, async (conn, from) => {
    const columns = await geometryColumns(conn, from);
    const { currentChoice } = geometryOwnership(table, state, columns);
    const candidates = await recognizeStoredContent(conn, from,
      await withBlankCoordinateFacts(conn, from, columns.filter(c => c.name !== table.geometryColumn)),
      trustedH3Ready, currentChoice);
    return {
      tableId: table.id, revision: geometryRevision(table), columns,
      geometryColumn: table.geometryColumn, geometryRecord: table.geometryRecord ?? null,
      currentChoice, mode: (state?.mode ?? "unmodified") as GeometryMode, candidates,
    };
  });
}

import { parseGeometryChoice, validateGeometryColumns } from "./choice";
import { evaluateGeometry } from "./evaluate";
import { measureGeometry, sampleGeometry } from "./preview";
import type { GeometryPreview } from "./types";

export function previewGeometry(scope: AccountScope, name: string, expectedRevision: string, input: unknown, signal?: AbortSignal): Promise<GeometryPreview> {
  return withTrustedOperation({ kind: "interactive-read", name: "Geometry preview", signal }, async () => {
    const table = requireGeometryTable(scope, name, expectedRevision);
    const choice = parseGeometryChoice(input);
    const state = getGeometryState(table);
    return readGeometry(table, async (conn, from) => {
      const columns = await geometryColumns(conn, from);
      const native = nativeGeometryChoice(table, state, columns, choice);
      validateGeometryColumns(choice, columns, native);
      const evaluated = await evaluateGeometry(conn, from, choice, native, INSPECT_PREVIEW_ROWS);
      try {
        const answer: GeometryPreview = {
          tableId: table.id, revision: geometryRevision(table), choice,
          canApply: evaluated.issues.length === 0, issues: evaluated.issues,
          ...await measureGeometry(conn, evaluated), degreeCompatible: evaluated.degreeCompatible,
          sample: { rows: [], features: { type: "FeatureCollection", features: [] } },
        };
        const budget = new ResultBudget();
        budget.take(jsonBytes(answer));
        answer.sample = await sampleGeometry(conn, evaluated, columns, budget);
        return answer;
      } finally { await evaluated.dispose(); }
    });
  });
}

export { setGeometry } from "./mutate";
export { clearGeometry } from "./clear";

export function inspectionEntriesForTests(): string[] { return cachedInspection.entriesForTests(); }
