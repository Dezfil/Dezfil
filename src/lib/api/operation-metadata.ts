/** Product effects are declared by each operation, never inferred from HTTP.
 * Derived caches and metadata clocks belong to their owning product resource.
 */
export type ProductResource =
  | "maps" | "layers" | "tables" | "publications" | "recipes" | "runs"
  | "projects" | "connections" | "palettes" | "accounts" | "settings" | "caches" | "assistant";

export interface ResourceWrite {
  resource: ProductResource;
  /** A stable identity in the submitted arguments, when already known. */
  argument?: string;
  /** Dot paths in the operation's response; * traverses an array.
   * Several paths cover single-object and multi-table import envelopes. */
  result?: string | readonly string[];
  /** The affected collection when no narrower target can be established. */
  collection: true;
}
export interface OperationEffects {
  readOnly: boolean;
  writes: ResourceWrite[];
  /** Boolean true asks for a plan/dry run and has no product effects. */
  planningArgument?: string;
  /** The operation's route records map history steps under the request's
   * change group: only such a write qualifies for the record's history
   * association. Undo, redo and a map's deletion write no step under the
   * group and declare nothing. */
  history?: true;
  /** Read-only here, but the operation sends a request outside this
   * server (a service's Test): the SQL and workflow assistants' read-only
   * policy refuses it, and the embedded assistant confirms it. */
  reachesOutside?: true;
}
export interface ConfirmationWords {
  /** Contains {target}, replaced with the resolved name and stable identity. */
  target: string;
  consequence: string;
  subject: {
    /** Null confirms the submitted identity without reading its content. */
    path: string | null;
    argument: string;
    name: string;
    /** A list read locates the subject by this identity field.
     * Empty collection path means the response itself is an array. */
    collection?: string;
    identity?: string;
  };
}
/** The pages the in-product assistant runs on. */
export type AssistantPage = "builder" | "sql" | "workflow";
/** What the assistant's record says about a call to this operation (spec
 * item 3): the verb of its line, with `{subject}` for the subject's name
 * or identity and `{arg.key}` for an argument's value, and where the
 * subject is found. Declared on every assistant-callable operation; the
 * effects stay the only authority for mutations and admission. */
export interface OperationDisplay {
  verb: string;
  /** The verb for a call whose planning argument is true, which starts
   * nothing; required where the effects declare a planning argument. */
  planningVerb?: string;
  subject?: {
    resource: ProductResource;
    /** The argument holding the subject's identity, when the call names it. */
    argument?: string;
    /** Dot path in the response holding the identity, for a created subject. */
    result?: string;
    /** Dot paths in the response, then the arguments, holding a display name. */
    name?: string | readonly string[];
  };
}
export const READ_ONLY: OperationEffects = { readOnly: true, writes: [] };
/** Changes nothing here, and reaches outside this server to do it. */
export const REACHES_OUTSIDE: OperationEffects = { readOnly: true, writes: [], reachesOutside: true };
export function writes(...resources: ResourceWrite[]): OperationEffects {
  return { readOnly: false, writes: resources };
}
export function resource(
  kind: ProductResource,
  argument?: string,
  result?: string | readonly string[],
): ResourceWrite {
  return { resource: kind, collection: true, ...(argument ? { argument } : {}), ...(result ? { result } : {}) };
}
export function planning(argument: string, effects: OperationEffects): OperationEffects {
  return { ...effects, planningArgument: argument };
}
/** A write whose route records history steps under the change group. */
export function recorded(effects: OperationEffects): OperationEffects {
  return { ...effects, history: true };
}
