/** SQL quoting for trusted statements containing file paths or reader names. */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
export function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
