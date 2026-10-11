/**
 * The coded refusals of a template's admission. Each names one class of
 * fault, so a caller branches on the code and a person reads the message;
 * the message names the member and the rule, never a path on this server.
 */
export const TEMPLATE_REFUSAL_CODES = [
  /** The archive is larger than the transfer bound. */
  "template_archive_too_large",
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
  /** An installed version whose members differ from its record. */
  "template_record_mismatch",
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
