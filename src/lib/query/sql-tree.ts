import type { DuckDBConnection } from "@duckdb/node-api";
import { parseSqlJson } from "./sql-json";
export type SqlNode = Record<string, unknown>;
export const isSqlNode = (value: unknown): value is SqlNode => typeof value === "object" && value !== null && !Array.isArray(value);
export async function parseSql(conn: DuckDBConnection, sql: string): Promise<SqlNode> {
  const rows = await conn.runAndReadAll("SELECT json_serialize_sql(?::VARCHAR) AS j", [sql]);
  return parseSqlJson(String(rows.getRowObjects()[0].j));
}
export async function sqlText(conn: DuckDBConnection, tree: SqlNode): Promise<string> {
  const rows = await conn.runAndReadAll("SELECT json_deserialize_sql(?::JSON) AS s", [JSON.stringify(tree)]);
  return String(rows.getRowObjects()[0].s);
}
export function selectNode(tree: SqlNode): SqlNode { return ((tree.statements as SqlNode[])[0].node as SqlNode); }
/** A table-function binder folds constants but refuses subqueries and columns. */
export async function constantArgument(conn: DuckDBConnection, expression: unknown): Promise<unknown> {
  const tree = await parseSql(conn, "SELECT * FROM repeat(NULL, 1)");
  const fn = (selectNode(tree).from_table as SqlNode).function as SqlNode;
  (fn.children as unknown[])[0] = expression;
  const rows = await conn.runAndReadAll(await sqlText(conn, tree));
  return Object.values(rows.getRowObjectsJson()[0] ?? {})[0];
}
export async function constantExpression(conn: DuckDBConnection, value: string | string[]): Promise<unknown> {
  const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const sql = typeof value === "string" ? literal(value) : `[${value.map(literal).join(",")}]`;
  return (selectNode(await parseSql(conn, `SELECT ${sql}`)).select_list as unknown[])[0];
}
