/** QualifiedName accepts quoted identifiers, including escaped quotes and dots.
 * Invalid names stay untouched for the engine to refuse in its usual way. */
export function qualifiedNameParts(name: string): string[] | null {
  const parts: string[] = [];
  let part = "", quoted = false, ended = false;
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    if (char === '"') {
      if (quoted && name[i + 1] === '"') { part += '"'; i++; }
      else if (quoted) { quoted = false; ended = true; }
      else if (!part && !ended) quoted = true;
      else return null;
    } else if (char === "." && !quoted) { parts.push(part); part = ""; ended = false; }
    else { if (ended || (!quoted && !/[\p{L}\p{N}_$]/u.test(char))) return null; part += char; }
  }
  if (quoted) return null;
  parts.push(part);
  if (parts.some(p => !p)) return null;
  return parts;
}

export function localName(name: string): string {
  const parts = qualifiedNameParts(name);
  if (!parts) return name;
  const lower = parts.map(p => p.toLowerCase());
  if ((parts.length === 2 && lower[0] === "memory") || (parts.length === 3 && lower[0] === "memory" && lower[1] === "main")) {
    return `temp.main."${parts.at(-1)!.replace(/"/g, '""')}"`;
  }
  return name;
}
