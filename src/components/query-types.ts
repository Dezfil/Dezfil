export interface QueryResult {
  columns: { name: string; type: string }[];
  rowCount: number;
  preview: Record<string, unknown>[];
  previewTruncated: boolean;
  runtimeMs: number;
}
