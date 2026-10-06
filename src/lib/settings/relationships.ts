export const TIMEOUT_RELATIONSHIP = "queryTimeoutS must be less than operationTimeoutS. The effective timeout limits do not satisfy this relationship.";

export function settingsWarnings(queryTimeoutS: number, operationTimeoutS: number): string[] {
  return queryTimeoutS >= operationTimeoutS ? [TIMEOUT_RELATIONSHIP] : [];
}
