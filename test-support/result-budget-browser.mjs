// Shared by the browser journey and native upload control.
export const datasetBudgetSQL = size => `SELECT repeat('x', ${size}) AS payload`;
