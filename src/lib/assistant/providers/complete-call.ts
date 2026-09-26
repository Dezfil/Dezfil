import { ProviderError } from "../provider";

export function completeArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
    return value;
  } catch { throw new ProviderError("The model returned incomplete or invalid tool arguments. No calls from this reply were executed.", "provider"); }
}
export function incompleteReply(): never {
  throw new ProviderError("The model response ended before a complete reply. No calls from this reply were executed.", "provider");
}
