/**
 * The client a person's own key rides. Both SDKs take a destination,
 * organization, project, alternate authentication and extra headers from the
 * environment when the constructor leaves them out, which is how the instance
 * key reaches the destination its operator chose. None of that may touch a
 * person's key: the options here name the provider's public address and that
 * key, and empty everything else the SDK would otherwise read.
 */

export type KeyPayer = "own" | "instance";

export const ANTHROPIC_PUBLIC_ADDRESS = "https://api.anthropic.com";
export const OPENAI_PUBLIC_ADDRESS = "https://api.openai.com/v1";

/** Each header the environment asks the SDK to add, cancelled. The SDK reads
 * the variable itself, so what it would add has to be named to be removed. */
function cancelled(headers: string | undefined): Record<string, null> {
  const names = (headers ?? "").split("\n").flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 ? [line.slice(0, colon).trim()] : [];
  });
  return Object.fromEntries(names.map((name) => [name, null]));
}

export function bareAnthropicOptions(apiKey: string, env: Record<string, string | undefined> = process.env) {
  return {
    apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_PUBLIC_ADDRESS,
    // The key is restated last, so a variable that names its header cannot replace it.
    defaultHeaders: { ...cancelled(env.ANTHROPIC_CUSTOM_HEADERS), "x-api-key": apiKey },
    // A redirect would carry the key's header to wherever it points.
    fetchOptions: { redirect: "error" as const },
    logLevel: "off" as const,
  };
}

export function bareOpenAIOptions(apiKey: string, env: Record<string, string | undefined> = process.env) {
  return {
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: OPENAI_PUBLIC_ADDRESS,
    defaultHeaders: { ...cancelled(env.OPENAI_CUSTOM_HEADERS), authorization: `Bearer ${apiKey}` },
    fetchOptions: { redirect: "error" as const },
    logLevel: "off" as const,
  };
}
