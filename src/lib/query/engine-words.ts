/**
 * The engine's own words in a failure message, told apart from the
 * sentences the app writes around them or in their place.
 *
 * DuckDB opens every error it raises with the error's kind: "Binder
 * Error: …", "Out of Range Error: …". The server passes such a diagnosis
 * on as the engine wrote it once it is safe to, and says anything else in
 * its own sentences, none of which opens that way. So the engine's words
 * are a message, or the end of one after the app's sentence, from the
 * first place an error's kind opens a sentence. Pure; shared by the
 * screens that show a failure.
 */

/** The kinds DuckDB names its errors by. */
const KINDS = [
  "Autoload",
  "Binder",
  "Catalog",
  "Connection",
  "Constraint",
  "Conversion",
  "Decimal",
  "Dependency",
  "Divide by Zero",
  "Executor",
  "Expression",
  "Extension Autoloading",
  "Fatal",
  "HTTP",
  "Index",
  "Internal",
  "Interrupt",
  "Invalid",
  "Invalid Configuration",
  "Invalid Input",
  "Invalid Type",
  "IO",
  "Mismatch Type",
  "Missing Extension",
  "Network",
  "Not implemented",
  "NullPointer",
  "Object Size",
  "Optimizer",
  "Out of Memory",
  "Out of Range",
  "Parameter Not Allowed",
  "Parameter Not Resolved",
  "Parser",
  "Permission",
  "Planner",
  "Scheduler",
  "Sequence",
  "Serialization",
  "Settings",
  "Stat",
  "Syntax",
  "Transaction",
  "TransactionContext",
  "Type",
  "Unknown Type",
];

/** An error's kind opening the message, or a sentence or line of it. */
const OPENS = new RegExp(`(?:^|(?<=[.!?:]\\s+)|(?<=\\n))(?:${KINDS.join("|")}) Error: `, "i");

/** A failure message in two parts: what the app wrote before the engine's
 * words, and the engine's words themselves, or null when it carries none. */
export function splitEngineWords(message: string): { lead: string; engine: string | null } {
  const at = message.search(OPENS);
  if (at < 0) return { lead: message, engine: null };
  return { lead: message.slice(0, at), engine: message.slice(at) };
}
