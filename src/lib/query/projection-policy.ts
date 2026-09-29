import { DuckDBScalarFunction, VARCHAR, type DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { crsReferencesFile } from "./crs-policy";
import { isSqlNode, parseSql, selectNode, type SqlNode } from "./sql-tree";

export const PROJECTION_REJECTION = "File-referencing coordinate definitions are not accepted. Use a CRS identifier or an inline definition without files.";
const MARKER = "__dezfil_projection_file_rejected__";
const FUNCTION = "__dezfil_checked_crs";
export function projectionRejection(error: unknown): ApiError | null {
  return error instanceof Error && error.message.includes(MARKER)
    ? new ApiError("sql_rejected", PROJECTION_REJECTION, 400) : null;
}

/** Install once on the hardened instance before lockdown. This pure identity
 * function validates the exact value handed to the native projection parser.
 * It has no filesystem access and grants no exemption to the SQL guard. */
export function registerCrsValidator(conn: DuckDBConnection): void {
  conn.registerScalarFunction(DuckDBScalarFunction.create({
    name: FUNCTION, parameterTypes: [VARCHAR], returnType: VARCHAR,
    mainFunction(info, input, output) {
      const values = input.getColumnVector(0);
      for (let row = 0; row < input.rowCount; row++) {
        const value = values.getItem(row);
        if (typeof value === "string" && crsReferencesFile(value)) { info.setError(MARKER); return; }
        output.setItem(row, value);
      }
      output.flush();
    },
  }));
}

/** Called after the syntax-only file check, before any dynamic argument can
 * be evaluated. The wrapper preserves overload selection, including the
 * three-argument typed-geometry form whose last argument is a boolean. */
export async function guardProjectionValues(conn: DuckDBConnection, tree: SqlNode): Promise<boolean> {
  let template: SqlNode | undefined;
  let changed = false;
  async function guarded(arg: unknown): Promise<SqlNode> {
    if (!template) {
      const parsed = await parseSql(conn, `SELECT cast_to_type(main.${FUNCTION}(CAST(NULL AS VARCHAR)), NULL)`);
      template = (selectNode(parsed).select_list as SqlNode[])[0];
    }
    const wrapper = structuredClone(template);
    const args = wrapper.children as SqlNode[];
    ((args[0].children as SqlNode[])[0]).child = arg;
    args[1] = arg as SqlNode;
    if (isSqlNode(arg)) wrapper.alias = arg.alias;
    return wrapper;
  }
  async function walk(value: unknown): Promise<void> {
    if (Array.isArray(value)) { for (const child of value) await walk(child); return; }
    if (!isSqlNode(value)) return;
    if (value.type === "UNBOUND_TYPE_INFO" && String(value.name).toLowerCase() === "geometry" && Array.isArray(value.user_type_modifiers)) {
      for (const modifier of value.user_type_modifiers) {
        if (isSqlNode(modifier) && typeof modifier.value === "string" && crsReferencesFile(modifier.value)) throw new ApiError("sql_rejected", PROJECTION_REJECTION, 400);
      }
    }
    for (const child of Object.values(value)) await walk(child);
    const name = String(value.function_name).toLowerCase();
    if ((name === "st_transform" || name === "st_setcrs") && Array.isArray(value.children)) {
      const args = value.children;
      for (let i = 1; i < Math.min(args.length, name === "st_transform" ? 3 : 2); i++) {
        const arg = args[i];
        if (isSqlNode(arg) && arg.class === "CONSTANT" && isSqlNode(arg.value) && typeof arg.value.value === "string" && crsReferencesFile(arg.value.value)) throw new ApiError("sql_rejected", PROJECTION_REJECTION, 400);
        args[i] = await guarded(arg);
      }
      changed = true;
    }
  }
  await walk(tree);
  return changed;
}
