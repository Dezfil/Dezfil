import type { CatalogueState, TemplateCard, TemplateList } from "@/lib/templates/card";
import { TEMPLATE_TAGS, type TemplateSource, type TemplateStep, type TemplateTag } from "@/lib/templates/format";
import { formatBytes } from "../api";
import type { Theme } from "../theme";
import type { WorkflowStep } from "../workflow-model";

/**
 * What the Templates page reads and how it words it: the card's lines, the
 * graph a workflow example draws, and the catalogue's one line. Every fact
 * is the template list's; this module only words it.
 */

/** Tags a card shows; the rest still count for the chips. */
export const CARD_TAGS = 2;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The data's date as a card says it: a year as written, a month as
 * "Oct 2026", a day as "3 Oct 2026". Anything else is shown as given. */
export function dataDateLabel(value: string): string {
  const parts = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!parts) return value;
  const [, year, month, day] = parts;
  if (!month) return year;
  const name = MONTHS[Number(month) - 1];
  if (!name) return value;
  return day ? `${Number(day)} ${name} ${year}` : `${name} ${year}`;
}

/** The credit line: each source's name, in the template's order, short
 * enough to read whole; the credit itself is the hint's. */
export function creditLine(sources: readonly TemplateSource[]): string {
  return sources.map((source) => source.name).join(" · ");
}

/** The credit in full, as the line's hint gives it: each source's credit
 * with its licence. */
export function creditInFull(sources: readonly TemplateSource[]): string {
  return sources.map((source) => `${source.credit} (${source.licence})`).join(" · ");
}

/** The tags a card draws: the first two, in the template's order. */
export function cardTags(tags: readonly TemplateTag[]): TemplateTag[] {
  return tags.slice(0, CARD_TAGS);
}

/** The line an absent version carries: what an open downloads first. */
export function absentLine(card: Pick<TemplateCard, "present" | "size">): string | null {
  return card.present ? null : `Downloads ${formatBytes(card.size)} when opened`;
}

/**
 * A workflow example's steps in the shape the Workflows page draws a
 * graph from: in their order, each making its output and reading what the
 * card says, with no parameters and nothing run, so every node draws as a
 * plain node and every read of a template dataset as a source.
 */
export function graphSteps(steps: readonly TemplateStep[]): WorkflowStep[] {
  return steps.map((step, index) => ({
    id: step.id,
    ordinal: index,
    operation: step.operation,
    parameters: {},
    proposedParameters: null,
    output: { id: step.id, name: step.output },
    condition: "current",
    conditions: ["current"],
    causes: [],
    missingInputs: [],
    inputs: [],
    reads: [...step.reads],
    latestAttempt: null,
    lastSuccessAt: null,
  }));
}

/** A workflow example's tools: each operation once, in the order its steps
 * first run it, by the name the operation catalog gives it. */
export function toolsLine(
  steps: readonly TemplateStep[],
  labelOf: (operation: string) => string,
): string {
  return [...new Set(steps.map((step) => step.operation))].map(labelOf).join(" · ");
}

/** The template's own address: where Open goes. */
export function templateAddress(id: string): string {
  return `/templates/${encodeURIComponent(id)}`;
}

/** A card's map picture in the viewer's theme. The version keys the
 * browser's cache, so a newer version's picture is never the older's. */
export function templatePictureAddress(id: string, version: number, theme: Theme): string {
  return `/api/templates/${encodeURIComponent(id)}/picture?v=${version}&theme=${theme}`;
}

/** Whether the page asks the server to read the catalogue again: never
 * while it is off, nor while its saved address cannot be read, since the
 * refresh refuses both and sends nothing. */
export function refreshes(catalogue: CatalogueState): boolean {
  return catalogue.state !== "off" && catalogue.reason !== "service_address_unreadable";
}

const ONLY_HERE = "so only the templates on this server show.";

/** Why the catalogue's templates are missing, in one line; null while it
 * lists them or has not been read. Never names the address. */
export function catalogueLine(catalogue: CatalogueState): string | null {
  switch (catalogue.state) {
    case "listed":
    case "not_read":
      return null;
    case "off":
      return `The template catalogue is turned off, ${ONLY_HERE}`;
    case "unreachable":
      return `The template catalogue did not answer, ${ONLY_HERE}`;
    case "slow":
      return `The template catalogue did not answer in time, ${ONLY_HERE}`;
    case "empty":
      return `The template catalogue lists no templates, ${ONLY_HERE}`;
    case "refused":
      return `${refusedWhy(catalogue)}, ${ONLY_HERE}`;
  }
}

function refusedWhy(catalogue: CatalogueState): string {
  switch (catalogue.reason) {
    case "status":
      return catalogue.status === null
        ? "The template catalogue refused the request"
        : `The template catalogue answered with status ${catalogue.status}`;
    case "egress_blocked":
      return "This server's network rules block the template catalogue";
    case "service_address_unreadable":
      return "The template catalogue's saved address can no longer be read";
    case "template_index_too_large":
      return "The template catalogue's list is too large to read";
    case "template_index_invalid":
      return "The template catalogue's list could not be read";
    case "template_index_repeats_id":
      return "The template catalogue's list names one template twice";
    case "template_address_outside":
      return "The template catalogue's list points outside the catalogue";
    default:
      return "The template catalogue refused the request";
  }
}

/** The line while the page reads the catalogue for the first time. */
export const READING_LINE = "Reading the template catalogue…";

/**
 * The page's one line about the catalogue, as it draws it: none before the
 * list answered; a refused refresh in the server's own words; while the
 * page's first read of the catalogue is under way, that it is being read;
 * else why the catalogue's templates are missing, or none. Every word comes
 * from the list's closed state or the server's refusal, never from the
 * catalogue's address.
 */
export function screenLine(list: TemplateList | null, refused: string | null, reading: boolean): string | null {
  if (list === null) return null;
  if (refused !== null) return refused;
  return reading && list.catalogue.state === "not_read" ? READING_LINE : catalogueLine(list.catalogue);
}

/** Whether a template answers the search: its title, question, place or
 * credit (each source's name and credit words) holds the text, in any
 * case. An empty search keeps every template. */
export function matchesSearch(
  card: Pick<TemplateCard, "title" | "question" | "place" | "sources">,
  query: string,
): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const fields = [card.title, card.question, card.place, ...card.sources.flatMap((s) => [s.name, s.credit])];
  return fields.some((field) => field.toLowerCase().includes(text));
}

/** The chip picked: every template, or those carrying one tag. */
export type TagPick = "all" | TemplateTag;

/** Whether a template carries the picked tag, its card shown or not. */
export function carriesTag(card: Pick<TemplateCard, "tags">, pick: TagPick): boolean {
  return pick === "all" || card.tags.includes(pick);
}

/**
 * The chips: All, then each tag a template on the list carries, in the
 * closed list's order; each counts the search's matches carrying it,
 * every tag counting, not only the two a card has room for.
 */
export function tagChips(
  cards: readonly TemplateCard[],
  query: string,
): { pick: TagPick; label: string; count: number }[] {
  const matches = cards.filter((card) => matchesSearch(card, query));
  const carried = new Set(cards.flatMap((card) => card.tags));
  return [
    { pick: "all", label: "All", count: matches.length },
    ...TEMPLATE_TAGS.filter((tag) => carried.has(tag)).map((tag) => ({
      pick: tag,
      label: tag,
      count: matches.filter((card) => card.tags.includes(tag)).length,
    })),
  ];
}

/** The one line when the search and the chip leave nothing. */
export const NO_MATCH_LINE = "No template matches. Clear the search or pick All.";
