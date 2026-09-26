/** Existing route responses made explicit for the MCP response contract. */
export const SKETCH_ROW_COUNT_RESPONSE = {
  description: 'The remaining row count after the feature change.',
  content: { 'application/json': { schema: { type: 'object', properties: { rowCount: { type: 'integer', minimum: 0 } }, required: ['rowCount'] } } },
};
export const QUERY_EXPORT_TICKET = { schema: {
  type: 'object', required: ['ticket', 'key', 'format'],
  properties: { ticket: { type: 'string' }, key: { type: 'string' }, format: { type: 'string', enum: ['geoparquet', 'geojson', 'csv'] } },
} };
export const PROJECT_EXPORT_TICKET = { schema: {
  type: 'object', required: ['ticket', 'key', 'filename', 'size'],
  properties: { ticket: { type: 'string' }, key: { type: 'string' }, filename: { type: 'string' }, size: { type: 'integer', minimum: 0 } },
} };
