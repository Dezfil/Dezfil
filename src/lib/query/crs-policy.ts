/** Inspect CRS values, never files. Native projection I/O is independent of
 * DuckDB's filesystem fence, so these values must be checked before PROJ sees
 * them, including values evaluated from a dataset column. */
const FILE_PARAMETERS = new Set([
  "init", "nadgrids", "geoidgrids", "grids", "xy_grids", "z_grids", "file", "model", "catalog",
]);

function projParameters(text: string): boolean {
  // PROJ permits whitespace around '=', but only double-quoted values hide
  // embedded tokens. Single quotes are ordinary characters in this grammar.
  const tokens = text.match(/"[^"]*"|=|[^\s"=]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i].replace(/^\+/, "").toLowerCase();
    if (!FILE_PARAMETERS.has(key) || tokens[i + 1] !== "=") continue;
    const value = (tokens[i + 2] ?? "").replace(/^"(.*)"$/s, "$1");
    // The legacy authority syntax resolves in the bundled CRS database.
    if (key === "init" && /^(epsg:\d+|ignf:[a-z0-9_]+)$/i.test(value)) continue;
    // PROJ's null grid is computation, with no resource to open.
    if (key.endsWith("grids") && value.split(",").every(v => /^@?null$/.test(v))) continue;
    return true;
  }
  return false;
}

function jsonFiles(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonFiles);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    // PROJJSON treats string-valued operation parameters as filenames. Decode
    // JSON before checking so escaped keys and values have identical treatment.
    if (key === "parameters" && Array.isArray(child) && child.some(p => p && typeof p.value === "string")) return true;
    if ((key === "proj4" || key === "name") && typeof child === "string") {
      const embedded = key === "proj4" ? child : child.replace(/^PROJ-based operation method(?: \(approximate\))?: /, "");
      if ((key === "proj4" || embedded !== child) && projParameters(embedded)) return true;
    }
    if (jsonFiles(child)) return true;
  }
  return false;
}

export function crsReferencesFile(value: string): boolean {
  // The C API sees only the prefix before a NUL, including JSON definitions.
  const text = value.split("\0", 1)[0].trim();
  if (text.startsWith("{")) {
    try { return jsonFiles(JSON.parse(text)); }
    catch { return false; } // Invalid JSON cannot reach an operation or a file.
  }
  if (/^[a-z][a-z0-9_]*\s*[\[(]/i.test(text)) {
    // Walk WKT tokens outside quoted labels; extension strings may contain
    // embedded PROJ parameters. Doubled quotes are WKT's string escape.
    const tokens = text.replace(/[“”]/g, '"').match(/"(?:[^"]|"")*"|[a-z_][a-z0-9_]*|[^\s]/gi) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      if (/^method$/i.test(tokens[i]) && ["[", "("].includes(tokens[i + 1])) {
        const method = tokens[i + 2]?.replace(/^"|"$/g, "").replace(/""/g, '\"') ?? "";
        const embedded = method.replace(/^PROJ-based operation method(?: \(approximate\))?: /, "");
        if (embedded !== method && projParameters(embedded)) return true;
      }
      if (/^parameterfile$/i.test(tokens[i]) && ["[", "("].includes(tokens[i + 1])) return true;
      if (/^extension$/i.test(tokens[i]) && ["[", "("].includes(tokens[i + 1])) {
        const key = tokens[i + 2]?.replace(/^"|"$/g, "").toLowerCase();
        const data = tokens[i + 4]?.replace(/^"|"$/g, "").replace(/""/g, '"') ?? "";
        if (key === "proj4_grids" && !/^@?null$/.test(data)) return true;
        if (key === "proj4" && projParameters(data)) return true;
      }
    }
    return false;
  }
  return projParameters(text);
}
