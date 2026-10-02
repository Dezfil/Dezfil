import { RESERVED_SQL_NAMES } from "@/lib/metadata/sql-names";

/**
 * The forms a written table name can take, as the engine would bind it:
 * plain (the home's namespace, also spelled `main.`, `temp.`, `memory.` and
 * `memory.main.`), qualified by a person's SQL name, or one of the engine's
 * own catalogues and schemas. Pure, so the guard, the compiler and the
 * resolver can all ask it.
 */

export type Classified =
  | { form: "plain"; name: string }
  | { form: "qualified"; qualifier: string; name: string }
  | { form: "engine" };

const LOCAL = new Set(["main", "temp", "memory"]);
const ENGINE = new Set(RESERVED_SQL_NAMES.filter((name) => !LOCAL.has(name)));
const MOUNT_NAME = /^([a-z][a-z0-9_]{2,31})\.([a-z0-9_]+)$/;

/** A name in the local namespace. An identifier spelled like a qualified
 * mount (`"ada.roads"`) is that qualified name: no dataset name contains a
 * dot. */
function local(name: string): Classified {
  const mount = MOUNT_NAME.exec(name);
  return mount ? { form: "qualified", qualifier: mount[1], name: mount[2] } : { form: "plain", name };
}

/**
 * The form of a name, case-insensitively, as the engine would bind it. A
 * local name keeps one meaning however it is spelled: `roads`, `main.roads`
 * and `memory.main.roads` are the same plain name, and `"ada.roads"`,
 * `main."ada.roads"` and `memory.main."ada.roads"` the same qualified one.
 */
export function classifyReference(parts: readonly string[]): Classified {
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.length === 1) return local(lower[0]);
  if (lower.length === 2) {
    if (LOCAL.has(lower[0])) return local(lower[1]);
    if (ENGINE.has(lower[0])) return { form: "engine" };
    return { form: "qualified", qualifier: lower[0], name: lower[1] };
  }
  if (lower.length === 3 && (lower[0] === "memory" || lower[0] === "temp") && lower[1] === "main") {
    return local(lower[2]);
  }
  return { form: "engine" };
}

/** A reference as a person would write it again, for a message. */
export function writtenReference(parts: readonly string[]): string {
  return parts.map((part) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `"${part.replace(/"/g, '""')}"`)).join(".");
}

