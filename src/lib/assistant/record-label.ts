import type { OperationDisplay, ProductResource } from "@/lib/api/operation-metadata";
import { valuesAt } from "./action-metadata";

/**
 * The record's words for one action, composed on the server when the
 * action happens from the operation's declared display, so no pane
 * keeps a list of operations and a later rename or deletion cannot
 * change what was recorded. `{subject}` takes the subject's display
 * name when the call or its response carried one, its identity
 * otherwise; `{arg.key}` takes an argument's value; a placeholder
 * nothing fills leaves the sentence without it.
 */

export interface RecordedSubject { resource: ProductResource; id?: string; name?: string }

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : typeof value === "number" ? String(value) : undefined;

export function recordedSubject(display: OperationDisplay, args: Record<string, unknown>, body?: unknown): RecordedSubject | undefined {
  const declared = display.subject;
  if (!declared) return undefined;
  const id = declared.argument ? text(args[declared.argument]) : declared.result ? text(valuesAt(body, declared.result)[0]) : undefined;
  const paths = declared.name === undefined ? [] : typeof declared.name === "string" ? [declared.name] : [...declared.name];
  let name: string | undefined;
  for (const path of paths) {
    name = text(valuesAt(body, path)[0]) ?? text(args[path]);
    if (name) break;
  }
  if (id === undefined && name === undefined) return { resource: declared.resource };
  return { resource: declared.resource, ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}) };
}

export function composeLabel(display: OperationDisplay, args: Record<string, unknown>, subject?: RecordedSubject, verb: string = display.verb): string {
  const filled = verb
    .replace(/\{subject\}/g, () => subject?.name ?? subject?.id ?? "")
    .replace(/\{arg\.([A-Za-z0-9_]+)\}/g, (_, key: string) => text(args[key]) ?? "");
  return filled.replace(/\s{2,}/g, " ").trim();
}
