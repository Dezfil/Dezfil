import { LOCAL_READ } from "./operation-mcp";
import { ERROR_RESPONSE, jsonOk, op } from "./openapi-helpers";
import { READ_ONLY } from "./operation-metadata";

const query = (name: string, description: string, schema: unknown = { type: "string" }) => ({ name, in: "query", required: false, description, schema });
export const TABLE_CATALOGUE_PATHS = {
  "/api/catalogue/tables": {
    get: op({
      summary: "Read the schema-only table catalogue",
      description: "Names, stable identities, recorded row counts and geometry facts with stored artifact column names and types. Reads metadata only, without evaluating row previews or healing geometry records. Recorded geometry identity is separate from the physical column type. Stable name order, at most 32 tables and 64 columns per table per page. after continues tables; columnOffset continues columns for a named table. total counts matching tables, columnCount counts each table’s columns. Incomplete collections carry nextAfter or nextColumnOffset. A missing artifact fails the read instead of returning a false empty schema. Responses are bounded to 96 KiB; a response that cannot fit answers 422 catalogue_too_large so the caller can request fewer tables or columns. No artifact paths, source configuration, credentials, row samples or attachment bytes are returned.",
      tag: "Tables", tool: "read_table_catalogue", mcp: LOCAL_READ, display: {"verb": "Read the table catalogue"}, relevance: ["builder", "sql", "workflow"], effects: READ_ONLY,
      parameters: [
        query("after", "Exclusive table-name cursor from nextAfter."),
        query("names", "Comma-separated exact table names, at most 32. Missing names answer not_found."),
        query("project", "Only this project's datasets; none means unfiled. Unknown project answers not_found."),
        query("limit", "Tables per page, 1 to 32; default 32.", { type: "integer", minimum: 1, maximum: 32 }),
        query("columns", "Columns per table, 0 to 64; default 64. Zero returns identities and recorded facts with the column count.", { type: "integer", minimum: 0, maximum: 64 }),
        query("columnOffset", "Zero-based column cursor, default 0.", { type: "integer", minimum: 0 }),
      ],
      responses: { "200": jsonOk("#/components/schemas/TableCatalogue"), "400": ERROR_RESPONSE, "404": ERROR_RESPONSE, "422": ERROR_RESPONSE },
    }),
  },
};
export const TABLE_CATALOGUE_SCHEMAS = {
  TableCatalogue: {
    type: "object", required: ["tables", "total", "nextAfter"],
    properties: {
      total: { type: "integer" }, nextAfter: { type: ["string", "null"] },
      tables: {
        type: "array", maxItems: 32,
        items: {
          type: "object",
          required: ["id", "name", "rowCount", "geometryColumn", "geometryType", "crsAssumed", "columns", "columnCount", "nextColumnOffset"],
          properties: {
            id: { type: "string" }, name: { type: "string" }, rowCount: { type: "integer" },
            geometryColumn: { type: ["string", "null"] }, geometryType: { type: ["string", "null"] }, crsAssumed: { type: "boolean" },
            columnCount: { type: "integer" }, nextColumnOffset: { type: ["integer", "null"] },
            columns: { type: "array", maxItems: 64, items: { type: "object", required: ["name", "type"], properties: { name: { type: "string" }, type: { type: "string" } } } },
          },
        },
      },
    },
  },
};
