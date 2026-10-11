/** Whitelist server envelopes. Text and SQL values remain exact data snapshots. */
type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
export function pick(value: unknown, keys: string[]): RecordValue {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
export function projectAttempt(value: unknown) {
  if (value === null || value === undefined) return null;
  const attempt = pick(value, ["id", "state", "acceptedAt", "startedAt", "finishedAt"]);
  const source = record(value);
  return { ...attempt, error: source.error ? pick(source.error, ["code", "message"]) : null, output: source.output ? pick(source.output, ["id", "name"]) : null };
}
export function projectStep(value: unknown) {
  const step = record(value);
  return {
    ...pick(step, ["id", "recipeId", "ordinal", "operation", "condition", "conditions", "lastSuccessAt"]),
    parameters: step.parameters, proposedParameters: step.proposedParameters,
    output: step.output ? pick(step.output, ["id", "name"]) : null,
    // A copied output came with a template's copy: no run made it, which is
    // why the step has no last success.
    templateResult: step.templateResult ? pick(step.templateResult, ["template", "version"]) : null,
    latestAttempt: projectAttempt(step.latestAttempt),
  };
}
export function projectMember(value: unknown) {
  const member = record(value);
  return {
    ...pick(member, ["stepId", "ordinal", "operation", "name", "state", "jobId", "stoppedBy", "stoppedReason"]),
    attempt: projectAttempt(member.attempt),
    output: member.output ? pick(member.output, ["id", "name"]) : null,
  };
}
