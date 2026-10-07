import { accountLook } from "@/lib/metadata/account-preferences";
import { lookAttributes, type Look, type LookAttributes } from "@/lib/look";

/**
 * The look a workspace document is served with: the root attributes of the
 * signed-in account's picks, read once, keyed by the one account the page
 * was admitted as and nothing else. Any failure of the read (a store that
 * cannot answer, a damaged preferences document) yields Dezfil's default
 * look, which carries no attributes: a page is never refused over its look,
 * and nothing is kept between reads, so no other account's look can stand
 * in for it.
 */
export function pageLook(accountId: string, read: (accountId: string) => Look = accountLook): LookAttributes {
  try {
    return lookAttributes(read(accountId));
  } catch {
    return {};
  }
}
