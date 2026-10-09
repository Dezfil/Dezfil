/**
 * What a part's Test answers, in a closed shape, and the page's words for
 * it: a pass with the time the check took, or one reason from a closed
 * list. Never a path, a program's output or an error's words. No server
 * import here: the System tab reads this module too.
 */

/** The parts of this server with a Test, in the order Status lists them. */
export const PARTS = ["data_folder", "query_engine", "metadata_database"] as const;
export type Part = typeof PARTS[number];

/** Why a Test failed: a program, or the spatial extension, is not where its
 * setting points; the part is busy with other work; no answer within the
 * Test's own limit; anything else. */
export const PART_FAILURES = ["not_found", "busy", "timed_out", "failed"] as const;
export type PartFailure = typeof PART_FAILURES[number];

export type PartTestAnswer =
  | { part: Part; result: "passed"; milliseconds: number }
  | { part: Part; result: "failed"; reason: PartFailure };

/** Each Test's own limit, in seconds. */
export const PART_TEST_LIMITS: Readonly<Record<Part, number>> = {
  data_folder: 5,
  query_engine: 30,
  metadata_database: 5,
};

export function isPart(value: unknown): value is Part {
  return typeof value === "string" && (PARTS as readonly string[]).includes(value);
}

/** A time as the answer line gives it: milliseconds below a second, else
 * seconds to one decimal. */
function took(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

const PASSED: Readonly<Record<Part, string>> = {
  data_folder: "Passed in",
  query_engine: "Answered in",
  metadata_database: "Answered in",
};
const FAILED: Readonly<Record<Part, string>> = {
  data_folder: "Could not write a file in the data folder.",
  query_engine: "The engine did not answer as it should.",
  metadata_database: "Could not read the database.",
};
const BUSY: Readonly<Partial<Record<Part, string>>> = {
  metadata_database: "Busy: another write holds the database.",
};
const NOT_FOUND: Readonly<Partial<Record<Part, string>>> = {
  query_engine: "The spatial extension is not installed where the engine looks.",
};

/** A Test's answer line. Never more than the answer's closed shape. */
export function partTestWords(answer: PartTestAnswer): { readonly passed: boolean; readonly text: string } {
  if (answer.result === "passed") return { passed: true, text: `${PASSED[answer.part]} ${took(answer.milliseconds)}` };
  switch (answer.reason) {
    case "not_found": return { passed: false, text: NOT_FOUND[answer.part] ?? "Not where its setting points." };
    case "busy": return { passed: false, text: BUSY[answer.part] ?? "Busy with other work." };
    case "timed_out": return { passed: false, text: `Did not finish within ${PART_TEST_LIMITS[answer.part]} seconds.` };
    case "failed": return { passed: false, text: FAILED[answer.part] };
  }
}
