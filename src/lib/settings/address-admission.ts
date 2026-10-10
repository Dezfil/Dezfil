import { ApiError } from "@/lib/api/errors";
import { resolveAllowed } from "@/lib/net/egress";
import { SETTING_CATALOGUE } from "./catalogue";
import { lockedEnvironment } from "./resolver";
import { validateStoredValue } from "./validation";

/**
 * The save-time check on a stored address (a service's, or the satellite
 * imagery's tile template), made before the change operation's write
 * transaction because resolving a name is asynchronous.
 *
 * A body's addresses that already pass the address kind (http or https, a
 * host, the length, and a template's placeholders) go through the egress
 * policy's own check, as a request to them would, a template with each
 * placeholder filled with a digit as a tile request fills it: a literal in blocked space, or a name all of whose
 * addresses resolve there, is refused unless the deployment's allowlist
 * names it by name or range. A name that does not resolve now is kept: a
 * save refuses blocked space, not an outage, and every use checks again on
 * the address it connects to. The lookup is the engine's own. Scheme and
 * length, a locked key and every other refusal stay the change operation's.
 */
export interface AddressAdmission {
  /** One per refused key: the key and the egress check's sentence, never the address. */
  readonly refusals: readonly string[];
  /** Each address the check saw, by key, exactly as the write will keep it. */
  readonly checked: ReadonlyMap<string, string>;
}

export async function admitServiceAddresses(input: unknown): Promise<AddressAdmission> {
  const refusals: string[] = [], checked = new Map<string, string>();
  if (!input || typeof input !== "object" || Array.isArray(input)) return { refusals, checked };
  for (const [key, value] of Object.entries(input)) {
    const definition = SETTING_CATALOGUE.find(candidate => candidate.key === key);
    const write = definition?.write;
    if (!definition || write?.kind !== "address" || lockedEnvironment(definition)) continue;
    const validated = validateStoredValue(definition, value);
    if (!validated.ok || typeof validated.value !== "string") continue;
    checked.set(key, validated.value);
    const refusal = await egressRefusal(withDigits(validated.value, write.placeholders ?? []));
    if (refusal) refusals.push(`${key}: ${refusal}`);
  }
  return { refusals, checked };
}

/** The address as a request reaches it: each placeholder filled with a digit. */
const withDigits = (address: string, placeholders: readonly string[]) =>
  placeholders.reduce((text, placeholder) => text.split(placeholder).join("0"), address);

/** The egress check's sentence when it would refuse the address now, else null. */
async function egressRefusal(address: string): Promise<string | null> {
  try {
    await resolveAllowed(new URL(address).hostname);
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.code === "egress_blocked") return error.message;
    // Not resolved now (no such name, no answer): kept, and checked at use.
    return null;
  }
}
