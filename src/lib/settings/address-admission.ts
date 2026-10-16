import { ApiError } from "@/lib/api/errors";
import { resolveAllowed } from "@/lib/net/egress";
import { SETTING_CATALOGUE } from "./catalogue";
import { carriesUserInformation } from "./disclosure";
import { lockedEnvironment } from "./resolver";
import { validateStoredValue } from "./validation";

/** Why a tile template carrying user information is refused at save: the
 * instance relays the imagery from the server and draws none from such an
 * address, so the key goes where the template already carries it. */
export const USER_INFORMATION_REFUSED =
  "Satellite imagery is not drawn from an address that carries a user name or password; put the key in the path or the query.";

/** The tile template's own rule, wherever the template is used: one carrying
 * a user name or password is refused at save, its Test is refused before any
 * request with the same sentence, and it counts as no imagery. Null while
 * the template may be used. */
export function tileTemplateRefusal(template: string): string | null {
  return carriesUserInformation(template) ? USER_INFORMATION_REFUSED : null;
}

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
 * the address it connects to. The lookup is the engine's own. The
 * imagery's tile template is refused here too, before any lookup, when it
 * carries user information: the imagery is not drawn from such an address.
 * One stored before, or set by its variable, has no save to refuse; its
 * read says so. Scheme and length, a locked key and every other refusal
 * stay the change operation's.
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
    const templateRefusal = write.userInformation === "refused" ? tileTemplateRefusal(validated.value) : null;
    if (templateRefusal) {
      refusals.push(`${key}: ${templateRefusal}`);
      continue;
    }
    const refusal = await egressRefusal(withDigits(validated.value, write.placeholders ?? []));
    if (refusal) refusals.push(`${key}: ${refusal}`);
  }
  return { refusals, checked };
}

/** The address as a request reaches it: each placeholder filled with a digit. */
const withDigits = (address: string, placeholders: readonly string[]) =>
  placeholders.reduce((text, placeholder) => text.split(placeholder).join("0"), address);

/** The egress check's sentence when it would refuse the address now, else
 * null: the save-time check a stored address takes, and the basemap
 * library's add before it reads a style. */
export async function egressRefusal(address: string): Promise<string | null> {
  try {
    await resolveAllowed(new URL(address).hostname);
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.code === "egress_blocked") return error.message;
    // Not resolved now (no such name, no answer): kept, and checked at use.
    return null;
  }
}
