/**
 * What an API failure names itself by (for OpenAI, for Anthropic). An HTTP
 * response carries a status; an error a provider delivers inside a 200 stream
 * carries none, and the SDK hands it on with whatever the body did name
 * instead. Reading the absent status as the network told the person their
 * connection had failed when their account had refused, so the failure names
 * itself by what it has: the first of the candidates it carries, in the order
 * the adapter lists them. With none of them the message stands alone, without
 * an empty parenthesis.
 *
 * The candidates differ by provider because the SDKs differ: OpenAI's APIError
 * carries `status`, `code` and `type`; Anthropic's carries `status` and `type`.
 * The rule over them is one rule, and lives here.
 */
export function apiFailureSentence(
  provider: string,
  candidates: readonly (string | number | null | undefined)[],
  message: string,
): string {
  const named = candidates.find(
    (value) =>
      typeof value === "number" || (typeof value === "string" && value !== ""),
  );
  return named === undefined
    ? `The ${provider} API request failed: ${message}`
    : `The ${provider} API request failed (${named}): ${message}`;
}
