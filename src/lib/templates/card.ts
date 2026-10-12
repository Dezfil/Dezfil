import type { TemplateFacts, TemplateKind, TemplateSource, TemplateStep, TemplateTag } from "./format";
import type { TemplateContents } from "./opened";

/**
 * What the template list answers, as data: one card per template and the
 * catalogue's state. Dependency-free on purpose, so the screens and the
 * API description read the same shapes and closed lists the server
 * answers with.
 */

/** Where the catalogue stands, as the list says it: read and listing
 * templates, read and listing none, not read yet in this process (or not
 * since its address or switch changed), switched off, nothing answered,
 * no answer within the link import's time bound, or refused (the reason
 * says by what). */
export const CATALOGUE_STATES = ["listed", "empty", "not_read", "off", "unreachable", "slow", "refused"] as const;
export type CatalogueStateName = (typeof CATALOGUE_STATES)[number];

/** Why the catalogue was refused: an answer with a status; the egress
 * rules; a saved address the instance's key no longer opens; or the
 * index's own refusals (over its bound, not one this server reads, an id
 * twice, an address outside the catalogue's origin or folder). */
export const CATALOGUE_REFUSALS = [
  "status",
  "egress_blocked",
  "service_address_unreadable",
  "template_index_too_large",
  "template_index_invalid",
  "template_index_repeats_id",
  "template_address_outside",
] as const;
export type CatalogueRefusal = (typeof CATALOGUE_REFUSALS)[number];

export interface CatalogueState {
  state: CatalogueStateName;
  /** The catalogue's scheme and host, never its path or query; null for a
   * folder or an address this server cannot read. */
  host: string | null;
  /** True when the deployment's variable names a folder on this server,
   * whose path is never given. */
  folder: boolean;
  /** When the list kept now was read; null before any read. */
  readAt: string | null;
  /** Why it was refused; null unless the state is refused. */
  reason: CatalogueRefusal | null;
  /** The status the catalogue answered with; null unless the reason is status. */
  status: number | null;
}

/** Whether a card's picture can be read: kept (shipped and downloaded
 * versions always), not kept (the catalogue's could not be read, or the
 * kept pictures reached their total first), or refused past its bound. */
export const CARD_PICTURES = ["kept", "not_kept", "too_large"] as const;
export type CardPicture = (typeof CARD_PICTURES)[number];

export interface TemplateCard {
  id: string;
  kind: TemplateKind;
  /** The version an open or a copy begun now takes: the newest listed,
   * unless the installed one is as new. */
  version: number;
  title: string;
  question: string;
  place: string;
  tags: TemplateTag[];
  dataDate: string;
  sources: TemplateSource[];
  /** A workflow example's steps in their order, each with what it runs,
   * makes and reads, as the Workflows page draws a workflow's graph; null
   * for a map template. */
  steps: TemplateStep[] | null;
  /** Shipped in the image, or listed by the catalogue. */
  origin: "shipped" | "catalogue";
  /** The version installed on this server, or null. */
  installed: number | null;
  /** The newest version the catalogue's kept list names, or null. */
  listed: number | null;
  /** Whether `version` is installed: false means an open downloads it. */
  present: boolean;
  /** The archive's size in bytes, as transferred. */
  size: number;
  picture: CardPicture;
}

/** One template as the read of one answers it: its card, how it is made,
 * and what the version holds once it is installed on this server. */
export interface TemplateDetail extends TemplateCard {
  howMade: TemplateFacts["howMade"];
  /** The installed version's contents; null while `version` is not on this
   * server, or its files do not read. */
  contents: TemplateContents | null;
}

/** What the downloaded templates hold on this server: how many versions,
 * and the bytes their folders take, which Remove all frees. */
export interface TemplateDownloads {
  versions: number;
  bytes: number;
}

export interface TemplateList {
  templates: TemplateCard[];
  catalogue: CatalogueState;
  downloads: TemplateDownloads;
}
