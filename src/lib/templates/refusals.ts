import { ApiError } from "@/lib/api/errors";

/**
 * The coded refusals of a template's admission. Each names one class of
 * fault, so a caller branches on the code and a person reads the message;
 * the message names the member and the rule, never a path on this server.
 */
export const TEMPLATE_REFUSAL_CODES = [
  /** The archive is larger than the transfer bound, or than the size the
   * catalogue's index declares for it. */
  "template_archive_too_large",
  /** The archive's bytes are not the ones the catalogue's index declares:
   * another size or another SHA-256. */
  "template_checksum_mismatch",
  /** The archive unpacks past the instance's upload cap. */
  "template_unpacked_too_large",
  /** Not a readable archive, or a document that is not JSON. */
  "template_malformed",
  /** A member whose path leaves the version's folder. */
  "template_entry_escapes",
  /** A member the documents name is missing, or a member nothing names. */
  "template_members_mismatch",
  /** A format version this server does not read. */
  "template_format_unsupported",
  /** A document that fails the rules a client's document is held to. */
  "template_invalid",
  /** A publication, token, connection, service address or setting. */
  "template_forbidden",
  /** A map picture past its bound. */
  "template_picture_too_large",
  /** A source under a licence that does not allow redistribution. */
  "template_licence_refused",
  /** The map's credit note does not name every source. */
  "template_credit_missing",
  /** A layer's SQL or a step's input names a dataset that is neither the
   * template's own nor a result of an earlier step. */
  "template_reference_outside",
  /** An installed version whose members differ from its record. */
  "template_record_mismatch",
  /** The catalogue's index is larger than its bound. */
  "template_index_too_large",
  /** The catalogue's index is not one this server reads: not JSON, not its
   * shape, or an entry whose facts are not a template's. */
  "template_index_invalid",
  /** The catalogue's index lists one template id twice. */
  "template_index_repeats_id",
  /** The catalogue's index names an archive or a picture outside the
   * catalogue's origin, or outside its folder. */
  "template_address_outside",
] as const;

export type TemplateRefusalCode = (typeof TEMPLATE_REFUSAL_CODES)[number];

export class TemplateRefusal extends Error {
  constructor(
    public readonly code: TemplateRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "TemplateRefusal";
  }
}

export function refuse(code: TemplateRefusalCode, message: string): never {
  throw new TemplateRefusal(code, message);
}

/** The catalogue index's own refusals, which a list states as its reason
 * rather than answering. */
const INDEX_REFUSALS: readonly TemplateRefusalCode[] = [
  "template_index_too_large", "template_index_invalid", "template_index_repeats_id", "template_address_outside",
];
/** The refusals an install can answer with, each an API error code: every
 * refusal but the index's own. */
export const INSTALL_REFUSAL_CODES = TEMPLATE_REFUSAL_CODES.filter(
  (code): code is InstallRefusalCode => !INDEX_REFUSALS.includes(code),
);
export type InstallRefusalCode = Exclude<TemplateRefusalCode,
  "template_index_too_large" | "template_index_invalid" | "template_index_repeats_id" | "template_address_outside">;

const TOO_LARGE: readonly TemplateRefusalCode[] = ["template_archive_too_large", "template_unpacked_too_large", "template_picture_too_large"];

/** An install's refusal as the API answers it: its code, its message, 413
 * for a bound and 422 for anything else. */
export function installRefusalError(refusal: TemplateRefusal): ApiError {
  if (INDEX_REFUSALS.includes(refusal.code)) throw new Error(`The index's refusal ${refusal.code} is not an install's.`);
  return new ApiError(refusal.code as InstallRefusalCode, refusal.message, TOO_LARGE.includes(refusal.code) ? 413 : 422);
}
