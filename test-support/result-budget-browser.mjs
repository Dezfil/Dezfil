// Shared by the browser journey and native upload control. Inspection shows
// long text as an excerpt; a list holds its text whole, so it can still refuse.
export const datasetBudgetSQL = size => `SELECT repeat('x', ${size}) AS payload`;
export const nestedBudgetSQL = size => `SELECT [repeat('x', ${size})] AS payload`;
