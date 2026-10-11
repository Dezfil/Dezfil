import type { Database } from "better-sqlite3";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { limits } from "@/lib/limits";
import { metadataDb } from "@/lib/metadata/db";
import { openRemote } from "@/lib/net/remote-fetch";
import { addressOrigin } from "@/lib/settings/disclosure";
import type { ServiceTestAnswer } from "@/lib/settings/service-test-answer";
import { serviceAddressUnreadable } from "@/lib/settings/service-address";
import type { CardPicture, CatalogueRefusal, CatalogueState, TemplateCard, TemplateDetail, TemplateList } from "./card";
import { downloadedTotals } from "./artifacts";
import { catalogueInUse, resolveTemplatesCatalogue, type CatalogueInEffect } from "./catalogue-address";
import {
  CATALOGUE_FORMAT_VERSION,
  CATALOGUE_INDEX_FILE,
  FACTS_FILE,
  TEMPLATE_ARCHIVE_MAX_BYTES,
  TEMPLATE_DOCUMENT_MAX_BYTES,
  TEMPLATE_FORMAT_VERSION,
  TEMPLATE_INDEX_MAX_BYTES,
  TEMPLATE_PICTURE_MAX_BYTES,
  TEMPLATE_THEMES,
  factsProblem,
  type TemplateFacts,
  type TemplateTheme,
} from "./format";
import { isTemplateVersion, parseTemplateVersion } from "./ids";
import { downloadedTemplatesDir, RECORD_FILE, recordProblem, type InstalledRecord } from "./installed";
import { refuse, TemplateRefusal } from "./refusals";
import { readShippedIndex } from "./shipped";
import { shippedTemplatesDir } from "./shipped-index";
import { templateContents } from "./view";

/**
 * The template catalogue as this server reads it, and the template list it
 * answers from what is on disk and what it last read.
 *
 * The list is local: the shipped set and the downloaded versions, read from
 * disk on every call, and the last list the catalogue answered, kept in
 * this process with the address it was read from. Only a refresh reaches
 * the catalogue, at most once in ten minutes: a refresh inside the window
 * sends nothing, and one while a read is under way joins it. The index and
 * the pictures go through the outbound engine under the egress check,
 * within the link import's time bound, with no credential on any request;
 * the kept list is replaced only when a new read is whole, and a read that
 * finishes after the address or the switch changed is discarded. Off, the
 * server reaches the catalogue for nothing.
 *
 * A shipped id wins over a catalogue entry naming it, and an installed
 * version is final: an entry naming the installed version is drawn as the
 * installed one.
 */

/** How long a read answers before a refresh reads again. */
export const REFRESH_WINDOW_MS = 10 * 60 * 1000;
/** The most bytes of pictures one kept list holds; entries past it are
 * drawn without one. */
export const PICTURES_TOTAL_BYTES = 64 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function catalogueOff(): ApiError {
  return new ApiError("templates_catalogue_off",
    "The template catalogue is turned off on this instance, so nothing is read from it. An admin turns it on in Settings.", 409);
}

export function templateNotListed(): ApiError {
  return new ApiError("template_not_listed", "No template with that id is shipped, downloaded or listed by the catalogue.", 404);
}

// ---------------------------------------------------------------------------
// The installed versions: shipped and downloaded, read light.

interface Installed {
  folder: string;
  facts: TemplateFacts;
  /** The archive's size as transferred, from the record. */
  size: number;
  sha256: string;
}

async function readSmall(file: string, max = TEMPLATE_DOCUMENT_MAX_BYTES): Promise<string> {
  if ((await stat(file)).size > max) throw new Error("larger than a document may be");
  return readFile(file, "utf8");
}

/** A version folder's facts and record, without the full read: what a card
 * needs. A folder whose documents do not read is left out of the list; an
 * open reads it whole and refuses it with its reason. */
async function readInstalledLight(folder: string, id: string, version: number): Promise<Installed | null> {
  try {
    const facts: unknown = JSON.parse(await readSmall(path.join(folder, FACTS_FILE)));
    const record: unknown = JSON.parse(await readSmall(path.join(folder, RECORD_FILE)));
    if (!isObject(facts) || facts.formatVersion !== TEMPLATE_FORMAT_VERSION || factsProblem(facts) !== null) return null;
    if (recordProblem(record) !== null) return null;
    const read = facts as unknown as TemplateFacts, kept = record as InstalledRecord;
    if (read.id !== id || read.version !== version || kept.id !== id || kept.version !== version) return null;
    return { folder, facts: read, size: kept.archive.size, sha256: kept.archive.sha256 };
  } catch {
    return null;
  }
}

/** The shipped set, in its index's order. */
async function shippedVersions(): Promise<Installed[]> {
  const dir = shippedTemplatesDir();
  let index;
  try {
    index = await readShippedIndex(dir);
  } catch {
    return [];
  }
  const out: Installed[] = [];
  for (const entry of index.templates) {
    const read = await readInstalledLight(path.join(dir, entry.id, String(entry.version)), entry.id, entry.version);
    if (read) out.push(read);
  }
  return out;
}

/** The newest downloaded version of each template, by id. */
async function downloadedVersions(): Promise<Map<string, Installed>> {
  const dir = downloadedTemplatesDir();
  const out = new Map<string, Installed>();
  let ids;
  try {
    ids = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of ids.filter((e) => e.isDirectory() && ID.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    let versions: number[];
    try {
      versions = (await readdir(path.join(dir, entry.name))).map(parseTemplateVersion).filter((v): v is number => v !== null);
    } catch {
      continue;
    }
    for (const version of versions.sort((a, b) => b - a)) {
      const read = await readInstalledLight(path.join(dir, entry.name, String(version)), entry.name, version);
      if (read) {
        out.set(entry.name, read);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The catalogue's index.

/** An index entry as kept: its addresses resolved, its pictures read. */
export interface ListedEntry {
  facts: TemplateFacts;
  size: number;
  sha256: string;
  /** The archive's address: an http or https address with no credential,
   * or a file inside the catalogue's folder. */
  archive: string;
  pictureAddresses: Record<TemplateTheme, string>;
  picture: { state: "kept"; light: Buffer; dark: Buffer } | { state: Exclude<CardPicture, "kept"> };
}

type Where = CatalogueInEffect;

/** An address with its user name and password taken out: no request this
 * module or the download sends carries a credential. */
export function withoutCredentials(url: URL): URL {
  const copy = new URL(url.toString());
  copy.username = "";
  copy.password = "";
  return copy;
}

/** Resolve one of the index's addresses: under the catalogue's origin, or
 * inside its folder; anything else refuses the whole index. */
function resolveEntryAddress(value: unknown, where: Where, at: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 2048) {
    refuse("template_index_invalid", `${at} must be an address.`);
  }
  if (where.kind === "address") {
    const base = new URL(where.address);
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      return refuse("template_index_invalid", `${at} is not an address.`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== base.origin) {
      refuse("template_address_outside", `${at} is outside the catalogue's origin.`);
    }
    return withoutCredentials(url).toString();
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || path.isAbsolute(value) || value.includes("\\")) {
    refuse("template_address_outside", `${at} is outside the catalogue's folder.`);
  }
  const file = path.resolve(where.folder, value);
  const relative = path.relative(where.folder, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    refuse("template_address_outside", `${at} is outside the catalogue's folder.`);
  }
  return file;
}

/**
 * Parse an index this server reads: its format, one entry per template id
 * with facts the format admits, a size within the archive bound, a SHA-256
 * and addresses under the catalogue's origin or inside its folder. An entry
 * whose facts are in a newer format than this server reads is left out, so
 * an older server still lists the rest. Anything else refuses the whole
 * index, coded.
 */
export function parseIndex(text: string, where: Where): Omit<ListedEntry, "picture">[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("template_index_invalid", "The catalogue's index is not JSON.");
  }
  if (!isObject(raw) || Object.keys(raw).some((k) => k !== "formatVersion" && k !== "templates")) {
    refuse("template_index_invalid", "The catalogue's index must be an object with formatVersion and templates.");
  }
  if (raw.formatVersion !== CATALOGUE_FORMAT_VERSION) {
    refuse("template_index_invalid", `The catalogue's index is in format ${String(raw.formatVersion)}; this server reads format ${CATALOGUE_FORMAT_VERSION}.`);
  }
  if (!Array.isArray(raw.templates)) refuse("template_index_invalid", "The catalogue's index must list its templates.");
  const entries: Omit<ListedEntry, "picture">[] = [];
  const ids = new Set<string>();
  for (const [i, entry] of (raw.templates as unknown[]).entries()) {
    const at = `templates[${i}]`;
    if (!isObject(entry)) refuse("template_index_invalid", `${at} must be an object.`);
    const keys = ["facts", "size", "sha256", "archive", "pictures"];
    if (Object.keys(entry).some((k) => !keys.includes(k)) || keys.some((k) => !(k in entry))) {
      refuse("template_index_invalid", `${at} holds exactly ${keys.join(", ")}.`);
    }
    const facts = entry.facts;
    if (isObject(facts) && Number.isSafeInteger(facts.formatVersion) && (facts.formatVersion as number) > TEMPLATE_FORMAT_VERSION) continue;
    if (!isObject(facts) || facts.formatVersion !== TEMPLATE_FORMAT_VERSION) {
      refuse("template_index_invalid", `${at}.facts must be in the template format this server reads.`);
    }
    const problem = factsProblem(facts);
    if (problem) refuse("template_index_invalid", `${at}.facts: ${problem}`);
    const read = facts as unknown as TemplateFacts;
    if (ids.has(read.id)) refuse("template_index_repeats_id", `The catalogue's index lists "${read.id}" twice.`);
    ids.add(read.id);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 1 || (entry.size as number) > TEMPLATE_ARCHIVE_MAX_BYTES) {
      refuse("template_index_invalid", `${at}.size must be the archive's size in bytes, at most ${TEMPLATE_ARCHIVE_MAX_BYTES}.`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) refuse("template_index_invalid", `${at}.sha256 must be a SHA-256 in hexadecimal.`);
    const pictures = entry.pictures;
    if (!isObject(pictures) || Object.keys(pictures).length !== TEMPLATE_THEMES.length || TEMPLATE_THEMES.some((t) => !(t in pictures))) {
      refuse("template_index_invalid", `${at}.pictures must give an address per theme.`);
    }
    entries.push({
      facts: read,
      size: entry.size as number,
      sha256: entry.sha256 as string,
      archive: resolveEntryAddress(entry.archive, where, `${at}.archive`),
      pictureAddresses: Object.fromEntries(TEMPLATE_THEMES.map((t) => [t, resolveEntryAddress(pictures[t], where, `${at}.pictures.${t}`)])) as Record<TemplateTheme, string>,
    });
  }
  return entries;
}

/** One request or file read: its bytes, a status, or past its bound. */
type Fetched = { kind: "bytes"; bytes: Buffer } | { kind: "status"; status: number } | { kind: "too_large" };

async function readBytesCapped(body: AsyncIterable<Buffer> & { destroy(): void }, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > max) {
      body.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** A redirect naming a user name or password is not followed: no request
 * this module or the download sends carries a credential. */
export function noCredentialHop(hop: { headers: { location?: string } }): void {
  const location = hop.headers.location;
  if (!location) return;
  let url: URL;
  try {
    url = new URL(location, "http://relative.invalid");
  } catch {
    return;
  }
  if (url.username || url.password) {
    throw new ApiError("remote_fetch_failed", "A redirect named a user name or password, and no catalogue request carries one.", 502);
  }
}

/** Read one address of the catalogue (an http or https address through the
 * outbound engine, or a file of its folder) within its bound and by the
 * deadline. */
async function fetchCapped(
  where: Where,
  address: string,
  max: number,
  deadlineAt: number,
  timeoutError: () => ApiError,
): Promise<Fetched> {
  if (where.kind === "folder") {
    if (Date.now() >= deadlineAt) throw timeoutError();
    if ((await stat(address)).size > max) return { kind: "too_large" };
    return { kind: "bytes", bytes: await readFile(address) };
  }
  const response = await openRemote(withoutCredentials(new URL(address)).toString(), {
    timeoutMs: Math.max(1, deadlineAt - Date.now()),
    timeoutError,
    onRedirect: noCredentialHop,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.body.destroy();
    return { kind: "status", status: response.statusCode };
  }
  if (Number(response.headers["content-length"]) > max) {
    response.body.destroy();
    return { kind: "too_large" };
  }
  const bytes = await readBytesCapped(response.body as unknown as AsyncIterable<Buffer> & { destroy(): void }, max);
  return bytes ? { kind: "bytes", bytes } : { kind: "too_large" };
}

/** The index at the catalogue in effect: its entries, or the status it
 * answered with. Past its bound, or not one this server reads, refused. */
async function readIndex(where: Where, deadlineAt: number, timeoutError: () => ApiError):
  Promise<{ kind: "index"; entries: Omit<ListedEntry, "picture">[] } | { kind: "status"; status: number }> {
  const address = where.kind === "address" ? where.address : path.join(where.folder, CATALOGUE_INDEX_FILE);
  const fetched = await fetchCapped(where, address, TEMPLATE_INDEX_MAX_BYTES, deadlineAt, timeoutError);
  if (fetched.kind === "status") return fetched;
  if (fetched.kind === "too_large") refuse("template_index_too_large", `The catalogue's index is larger than ${TEMPLATE_INDEX_MAX_BYTES} bytes.`);
  return { kind: "index", entries: parseIndex(fetched.bytes.toString("utf8"), where) };
}

const isPng = (bytes: Buffer) => bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/** The outcome of one read of the catalogue, as kept. */
interface Read {
  /** The address or folder it was read from. */
  key: string;
  startedAt: number;
  state: "listed" | "empty" | "unreachable" | "slow" | "refused";
  reason: CatalogueRefusal | null;
  status: number | null;
  entries: ListedEntry[];
}

export interface RefreshOptions {
  now?: number;
  /** The pictures' total, below the module's own for a test. */
  pictureTotal?: number;
}

function failedRead(key: string, startedAt: number, state: Read["state"], reason: CatalogueRefusal | null = null, status: number | null = null): Read {
  return { key, startedAt, state, reason, status, entries: [] };
}

/** Read the catalogue whole: the index, then the pictures in its order. */
async function readCatalogue(where: Where, key: string, startedAt: number, pictureTotal: number): Promise<Read> {
  const deadlineAt = Date.now() + limits.remoteTimeoutMs;
  const timedOut = new ApiError("remote_timeout", "The catalogue did not answer within the link import's time bound.", 504);
  const timeoutError = () => timedOut;
  let index;
  try {
    index = await readIndex(where, deadlineAt, timeoutError);
  } catch (error) {
    if (error === timedOut) return failedRead(key, startedAt, "slow");
    if (error instanceof TemplateRefusal) return failedRead(key, startedAt, "refused", error.code as CatalogueRefusal);
    if (error instanceof ApiError && error.code === "egress_blocked") return failedRead(key, startedAt, "refused", "egress_blocked");
    return failedRead(key, startedAt, "unreachable");
  }
  if (index.kind === "status") return failedRead(key, startedAt, "refused", "status", index.status);
  if (index.entries.length === 0) return { key, startedAt, state: "empty", reason: null, status: null, entries: [] };

  // Pictures for the entries a card draws from the catalogue: a shipped id
  // wins, and an installed version has its pictures on disk.
  const shipped = new Set((await shippedVersions()).map((v) => v.facts.id));
  const downloaded = await downloadedVersions();
  const entries: ListedEntry[] = [];
  let kept = 0;
  let stopped = false;
  for (const entry of index.entries) {
    const fromDisk = shipped.has(entry.facts.id) || (downloaded.get(entry.facts.id)?.facts.version ?? 0) >= entry.facts.version;
    if (fromDisk || stopped) {
      entries.push({ ...entry, picture: { state: "not_kept" } });
      continue;
    }
    const pair: Partial<Record<TemplateTheme, Buffer>> = {};
    let picture: ListedEntry["picture"] = { state: "not_kept" };
    try {
      for (const theme of TEMPLATE_THEMES) {
        const fetched = await fetchCapped(where, entry.pictureAddresses[theme], TEMPLATE_PICTURE_MAX_BYTES, deadlineAt, timeoutError);
        if (fetched.kind === "too_large") {
          picture = { state: "too_large" };
          break;
        }
        if (fetched.kind === "status" || !isPng(fetched.bytes)) break;
        pair[theme] = fetched.bytes;
      }
    } catch (error) {
      // Past the deadline no later picture is asked for; any other failure
      // leaves this one's card without its picture.
      if (error === timedOut) stopped = true;
    }
    if (pair.light && pair.dark) {
      const bytes = pair.light.length + pair.dark.length;
      if (kept + bytes > pictureTotal) {
        stopped = true;
      } else {
        kept += bytes;
        picture = { state: "kept", light: pair.light, dark: pair.dark };
      }
    }
    entries.push({ ...entry, picture });
  }
  return { key, startedAt, state: "listed", reason: null, status: null, entries };
}

// ---------------------------------------------------------------------------
// What this process keeps.

interface Holder {
  /** Bumped whenever the address or the switch is seen to change: a read
   * begun before it is discarded when it finishes. */
  epoch: number;
  /** The switch and address last seen. */
  seen: string | null;
  kept: Read | null;
  reading: { key: string; epoch: number; promise: Promise<void> } | null;
}

const HOLDER = Symbol.for("dezfil.template-catalogue");
const host = globalThis as typeof globalThis & { [HOLDER]?: Holder };
const holder: Holder = host[HOLDER] ??= { epoch: 0, seen: null, kept: null, reading: null };

/** Where the catalogue is now, as far as the kept list cares: off, a
 * refused address, or the address or folder a read takes. */
type Now =
  | { kind: "off"; host: string | null; folder: boolean }
  | { kind: "unreadable" }
  | { kind: "on"; where: Where; key: string; host: string | null; folder: boolean };

function describe(where: Where): { key: string; host: string | null; folder: boolean } {
  return where.kind === "folder"
    ? { key: `folder:${where.folder}`, host: null, folder: true }
    : { key: `address:${where.address}`, host: addressOrigin(where.address), folder: false };
}

function catalogueNow(db: Database): Now {
  let where: Where | null = null;
  try {
    where = resolveTemplatesCatalogue(db);
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "service_address_unreadable")) throw error;
  }
  const on = catalogueInUse(db);
  const seen = !on ? `off:${where ? describe(where).key : ""}` : where ? describe(where).key : "unreadable";
  if (seen !== holder.seen) {
    // The address or the switch changed: the kept list goes, and a read
    // under way is discarded when it finishes.
    holder.seen = seen;
    holder.kept = null;
    holder.epoch += 1;
  }
  if (!on) return { kind: "off", host: where ? describe(where).host : null, folder: where?.kind === "folder" };
  if (!where) return { kind: "unreadable" };
  return { kind: "on", where, ...describe(where) };
}

function stateOf(now: Now): CatalogueState {
  if (now.kind === "off") return { state: "off", host: now.host, folder: now.folder, readAt: null, reason: null, status: null };
  if (now.kind === "unreadable") {
    return { state: "refused", host: null, folder: false, readAt: null, reason: "service_address_unreadable", status: null };
  }
  const kept = holder.kept;
  if (!kept || kept.key !== now.key) return { state: "not_read", host: now.host, folder: now.folder, readAt: null, reason: null, status: null };
  return { state: kept.state, host: now.host, folder: now.folder, readAt: new Date(kept.startedAt).toISOString(), reason: kept.reason, status: kept.status };
}

// ---------------------------------------------------------------------------
// The list.

/** What a card says of one version, from its facts. */
function cardFacts(facts: TemplateFacts): Omit<TemplateCard, "origin" | "installed" | "listed" | "present" | "size" | "picture"> {
  return {
    id: facts.id, kind: facts.kind, version: facts.version, title: facts.title, question: facts.question,
    place: facts.place, tags: [...facts.tags], dataDate: facts.dataDate, sources: facts.sources.map((s) => ({ ...s })),
    steps: facts.kind === "workflow" ? (facts.steps ?? []).map((s) => ({ ...s, reads: [...s.reads] })) : null,
  };
}

function card(facts: TemplateFacts, fields: Pick<TemplateCard, "origin" | "installed" | "listed" | "present" | "size" | "picture">): TemplateCard {
  return { ...cardFacts(facts), ...fields };
}

/** Each template a card draws, with where its facts and pictures come from. */
interface Drawn {
  card: TemplateCard;
  facts: TemplateFacts;
  installed: Installed | null;
  listed: ListedEntry | null;
}

async function drawn(now: Now): Promise<Drawn[]> {
  const shipped = await shippedVersions();
  const downloaded = await downloadedVersions();
  const shippedIds = new Set(shipped.map((v) => v.facts.id));
  const out: Drawn[] = shipped.map((v) => ({
    card: card(v.facts, { origin: "shipped", installed: v.facts.version, listed: null, present: true, size: v.size, picture: "kept" }),
    facts: v.facts, installed: v, listed: null,
  }));
  const kept = now.kind === "on" && holder.kept?.key === now.key ? holder.kept.entries : [];
  const drawnIds = new Set(shippedIds);
  for (const entry of kept) {
    if (drawnIds.has(entry.facts.id)) continue;
    drawnIds.add(entry.facts.id);
    const installed = downloaded.get(entry.facts.id) ?? null;
    const fromDisk = installed !== null && installed.facts.version >= entry.facts.version;
    out.push({
      card: card(fromDisk ? installed.facts : entry.facts, {
        origin: "catalogue", installed: installed?.facts.version ?? null, listed: entry.facts.version, present: fromDisk,
        size: fromDisk ? installed.size : entry.size, picture: fromDisk ? "kept" : entry.picture.state,
      }),
      facts: fromDisk ? installed.facts : entry.facts, installed, listed: entry,
    });
  }
  for (const [id, installed] of downloaded) {
    if (drawnIds.has(id)) continue;
    out.push({
      card: card(installed.facts, { origin: "catalogue", installed: installed.facts.version, listed: null, present: true, size: installed.size, picture: "kept" }),
      facts: installed.facts, installed, listed: null,
    });
  }
  return out;
}

/** The template list, from disk and the kept list; nothing is sent. */
export async function listTemplates(db: Database = metadataDb()): Promise<TemplateList> {
  const now = catalogueNow(db);
  return { templates: (await drawn(now)).map((d) => d.card), catalogue: stateOf(now), downloads: await downloadedTotals() };
}

async function find(id: string, db: Database): Promise<Drawn> {
  const found = (await drawn(catalogueNow(db))).find((d) => d.card.id === id);
  if (!found) throw templateNotListed();
  return found;
}

/**
 * One template: its card, how it is made and, once its version is
 * installed, what the version holds; nothing is sent. Without a version it
 * reads the one the card takes now. A version named is read as it is: one
 * installed on this server (a shipped template's shipped version, or a
 * download whole by its record), else the one the kept list names; any
 * other is not listed. So a reader that described one version reads that
 * one again, whatever the catalogue listed meanwhile.
 */
export async function readTemplate(id: string, db: Database = metadataDb(), version: number | null = null): Promise<TemplateDetail> {
  const found = await find(id, db);
  let card = found.card, facts = found.facts;
  if (version !== null && version !== card.version) {
    const installed = card.origin === "shipped"
      ? null
      : await readInstalledLight(path.join(downloadedTemplatesDir(), id, String(version)), id, version);
    const listed = found.listed?.facts.version === version ? found.listed : null;
    if (installed) {
      facts = installed.facts;
      card = { ...card, ...cardFacts(facts), present: true, size: installed.size, picture: "kept" };
    } else if (listed) {
      facts = listed.facts;
      card = { ...card, ...cardFacts(facts), present: false, size: listed.size, picture: listed.picture.state };
    } else {
      throw templateNotListed();
    }
  }
  return {
    ...card,
    howMade: structuredClone(facts.howMade),
    contents: card.present ? templateContents(card.id, card.version) : null,
  };
}

/**
 * One template for its own address, which may be shared before this process
 * has read the catalogue: as the read of one answers, except that an id it
 * does not know, while the catalogue is in use, has the catalogue read first
 * on the refresh's own road (under its ten-minute rule, so a list read a
 * moment ago answers and nothing is sent; off, or at a saved address the
 * key no longer opens, nothing is sent at all). Not listed then either, it
 * is not listed. An id no template can have reads nothing.
 */
export async function readTemplateForAddress(id: string, db: Database = metadataDb()): Promise<TemplateDetail> {
  try {
    return await readTemplate(id, db);
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "template_not_listed") || !ID.test(id)) throw error;
    try {
      await refreshCatalogue(db);
    } catch (refused) {
      // Off, or a saved address the key no longer opens: the refresh sent
      // nothing, and the template is not listed.
      if (refused instanceof ApiError) throw error;
      throw refused;
    }
    return readTemplate(id, db);
  }
}

/** A template's picture in one theme, or null when none can be read. */
export async function templatePicture(id: string, theme: TemplateTheme, db: Database = metadataDb()): Promise<Buffer | null> {
  const found = await find(id, db);
  if (found.card.present && found.installed) {
    try {
      const bytes = await readFile(path.join(found.installed.folder, found.facts.pictures[theme]));
      return bytes.length <= TEMPLATE_PICTURE_MAX_BYTES && isPng(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }
  const picture = found.listed?.picture;
  return picture?.state === "kept" ? picture[theme] : null;
}

/**
 * Refresh the kept list: off, refused with the switch's reason and nothing
 * sent; a saved address the key no longer opens, refused as every service
 * refuses it; inside the window, the kept list as it is; a read under way,
 * joined; else one read, kept when it is whole and still current. Answers
 * the list.
 */
export async function refreshCatalogue(db: Database = metadataDb(), options: RefreshOptions = {}): Promise<TemplateList> {
  const now = catalogueNow(db);
  if (now.kind === "off") throw catalogueOff();
  if (now.kind === "unreadable") throw serviceAddressUnreadable("templatesCatalogueUrl");
  const startedAt = options.now ?? Date.now();
  const reading = holder.reading;
  if (reading && reading.key === now.key && reading.epoch === holder.epoch) {
    await reading.promise;
  } else if (!(holder.kept && holder.kept.key === now.key && startedAt - holder.kept.startedAt < REFRESH_WINDOW_MS)) {
    const epoch = holder.epoch;
    const promise = readCatalogue(now.where, now.key, startedAt, options.pictureTotal ?? PICTURES_TOTAL_BYTES).then((read) => {
      // Kept only while still current: the same switch and address, seen
      // again now, and no change in between.
      let current: Now;
      try {
        current = catalogueNow(db);
      } catch {
        return;
      }
      if (holder.epoch === epoch && current.kind === "on" && current.key === read.key) holder.kept = read;
    }).finally(() => {
      if (holder.reading?.promise === promise) holder.reading = null;
    });
    holder.reading = { key: now.key, epoch, promise };
    await promise;
  }
  return listTemplates(db);
}

/** A downloaded version's archive size when it is installed (its facts and
 * record read light, as the list reads them), else null. */
export async function downloadedSize(id: string, version: number): Promise<number | null> {
  if (!ID.test(id) || !isTemplateVersion(version)) return null;
  return (await readInstalledLight(path.join(downloadedTemplatesDir(), id, String(version)), id, version))?.size ?? null;
}

/** The refusal for a listed version that is not installed: a copy is
 * local, so the version is fetched first. */
export function templateNotInstalled(id: string, version: number): ApiError {
  return new ApiError("template_not_installed",
    `Version ${version} of the template "${id}" is listed by the catalogue but not on this server yet: fetch it ` +
    `(POST /api/templates/${id}/fetch), then copy it. Nothing was created.`, 409);
}

/** The installed version a copy reads, with its folder. */
export interface CopySource {
  id: string;
  version: number;
  folder: string;
}

/**
 * The version a copy of `id` reads: the one named, else the installed one
 * (a shipped template's shipped version; else the newest download whole by
 * its record). A copy is local: an installed version is copied whether the
 * catalogue still lists it or not, and with the catalogue off. A version
 * that is not installed is refused, and nothing is sent: the one the kept
 * list names, as not installed yet, naming the fetch; while the catalogue
 * is off, with the switch's reason; a saved address the key no longer
 * opens, as every service refuses it; any other, as not listed.
 */
export async function copySource(id: string, version: number | null, db: Database = metadataDb()): Promise<CopySource> {
  if (!ID.test(id)) throw templateNotListed();
  const shipped = (await shippedVersions()).find((v) => v.facts.id === id);
  if (shipped) {
    if (version !== null && version !== shipped.facts.version) throw templateNotListed();
    return { id, version: shipped.facts.version, folder: shipped.folder };
  }
  const installed = version === null
    ? (await downloadedVersions()).get(id) ?? null
    : await readInstalledLight(path.join(downloadedTemplatesDir(), id, String(version)), id, version);
  if (installed) return { id, version: installed.facts.version, folder: installed.folder };
  const now = catalogueNow(db);
  if (now.kind === "off") throw catalogueOff();
  if (now.kind === "unreadable") throw serviceAddressUnreadable("templatesCatalogueUrl");
  const entry = holder.kept?.key === now.key ? holder.kept.entries.find((e) => e.facts.id === id) : undefined;
  if (!entry || (version !== null && entry.facts.version !== version)) throw templateNotListed();
  throw templateNotInstalled(id, entry.facts.version);
}

/** The version a fetch acts on: installed already, or the one the kept list
 * names, with where the catalogue is read. */
export type FetchTarget =
  | { kind: "installed"; id: string; version: number; size: number }
  | { kind: "listed"; entry: ListedEntry; where: CatalogueInEffect };

/**
 * The version a fetch of `id` acts on: the one named, else the one its card
 * takes now (the newest listed, unless the installed one is as new). A
 * shipped id has its shipped version alone. An installed version (shipped,
 * or downloaded and whole by its record) is answered as it is, and nothing
 * is sent. Any other must be the version the kept list names, with the
 * catalogue in use: off, refused with the switch's reason; a saved address
 * the key no longer opens, refused as every service refuses it; a version
 * the kept list does not name, not listed. Nothing is read from the
 * catalogue here: what it lists is what the last refresh kept.
 */
export async function fetchTarget(id: string, version: number | null, db: Database = metadataDb()): Promise<FetchTarget> {
  if (!ID.test(id)) throw templateNotListed();
  const now = catalogueNow(db);
  const shipped = (await shippedVersions()).find((v) => v.facts.id === id);
  if (shipped) {
    if (version !== null && version !== shipped.facts.version) throw templateNotListed();
    return { kind: "installed", id, version: shipped.facts.version, size: shipped.size };
  }
  const wanted = version ?? (await drawn(now)).find((d) => d.card.id === id)?.card.version ?? null;
  if (wanted !== null) {
    const installed = await downloadedSize(id, wanted);
    if (installed !== null) return { kind: "installed", id, version: wanted, size: installed };
  }
  if (now.kind === "off") throw catalogueOff();
  if (now.kind === "unreadable") throw serviceAddressUnreadable("templatesCatalogueUrl");
  const entry = holder.kept?.key === now.key ? holder.kept.entries.find((e) => e.facts.id === id) : undefined;
  if (!entry || entry.facts.version !== wanted) throw templateNotListed();
  return { kind: "listed", entry, where: now.where };
}

/** At a download's turn, the catalogue still in use where the version was
 * listed: off, refused with the switch's reason; a saved address the key no
 * longer opens, refused as every service refuses it; another address or
 * folder now, the version is not listed there. */
export function requireCatalogueAt(where: CatalogueInEffect, db: Database = metadataDb()): void {
  const now = catalogueNow(db);
  if (now.kind === "off") throw catalogueOff();
  if (now.kind === "unreadable") throw serviceAddressUnreadable("templatesCatalogueUrl");
  if (now.key !== describe(where).key) throw templateNotListed();
}

/**
 * The catalogue's Test: its index at the address in effect, read as a
 * refresh reads it, with no picture and nothing kept. Passes with how many
 * templates it lists and the time taken; an index this server would refuse
 * is an answer, but not as the catalogue gives one. Off, refused with the
 * switch's reason and nothing sent.
 */
export async function testCatalogue(deadline: () => ApiError, db: Database = metadataDb()): Promise<ServiceTestAnswer> {
  if (!catalogueInUse(db)) throw catalogueOff();
  const where = resolveTemplatesCatalogue(db);
  const started = Date.now();
  let index;
  try {
    index = await readIndex(where, started + limits.remoteTimeoutMs, deadline);
  } catch (error) {
    if (error instanceof TemplateRefusal) return { service: "templates", result: "failed", reason: "unexpected_answer" };
    throw error;
  }
  if (index.kind === "status") return { service: "templates", result: "failed", reason: "status", status: index.status };
  return { service: "templates", result: "passed", templates: index.entries.length, milliseconds: Date.now() - started };
}

/** Forget what this process keeps: for a test's fresh start. */
export function resetCatalogueForTests(): void {
  holder.epoch += 1;
  holder.seen = null;
  holder.kept = null;
  holder.reading = null;
}
