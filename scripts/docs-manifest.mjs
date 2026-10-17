// The image manifest's rules, held by `npm run lint:docs` beside the page
// contract: every picture and recording under docs/images/ has a row and is
// used, every row's file exists, the row's size, bytes and length are the
// file's own (read from its header), the size is the frame or the declared
// crop at two pixels per CSS pixel, and every file is within its bound.
//
// These rules are the product lint's alone: the documentation site copies
// the files as the manifest lists them and holds its own size limits over
// the built folder, so they are not in the shared contract cases, and each
// is seeded red by its own test over real WebP and WebM bytes.
import path from "node:path";
import { FRAME, PICTURE_MAX_BYTES, RECORDING_MAX_BYTES, RECORDING_MAX_SECONDS, RECORDINGS_MAX, webmInfo, webpSize } from "./docs-media.mjs";
import { placeOf, references } from "./docs-contract.mjs";

const MANIFEST = "docs/images/manifest.json";
const IMAGES = "docs/images/";
const ROW_FIELDS = new Set(["file", "scene", "kind", "version", "date", "width", "height", "bytes", "crop", "length", "poster"]);
const problem = (file, rule, message) => ({ file, rule, message });
const whole = (value) => Number.isInteger(value) && value > 0;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** What is wrong with a row's form, or null. */
function rowIssue(row) {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return "a row must be a set of fields";
  const extra = Object.keys(row).find((key) => !ROW_FIELDS.has(key));
  if (extra) return `the field ${extra} is not part of a row`;
  if (typeof row.file !== "string" || !row.file) return "file must name a file under docs/images/";
  const place = placeOf(`${IMAGES}${row.file}`);
  if (place.kind !== "picture" && place.kind !== "recording") return `${row.file} is not a picture or recording under a section folder`;
  if (row.kind !== place.kind) return `kind must be ${place.kind} for a .${row.file.split(".").pop()} file`;
  if (typeof row.scene !== "string" || !row.scene) return "scene must name the scene in the picture script's list";
  if (typeof row.version !== "string" || !VERSION.test(row.version)) return "version must be the app version, three numbers";
  if (typeof row.date !== "string" || !DATE.test(row.date)) return "date must be written YYYY-MM-DD";
  for (const field of ["width", "height", "bytes"]) if (!whole(row[field])) return `${field} must be a whole number above zero`;
  if ("crop" in row) {
    const crop = row.crop;
    if (typeof crop !== "object" || crop === null || !["x", "y"].every((k) => Number.isInteger(crop[k]) && crop[k] >= 0) || !whole(crop.width) || !whole(crop.height) || Object.keys(crop).length !== 4) {
      return "crop must give x, y, width and height in whole CSS pixels";
    }
  }
  if (row.kind === "recording") {
    if (typeof row.length !== "number" || !(row.length > 0)) return "a recording's length must be its seconds";
    if (typeof row.poster !== "string" || placeOf(`${IMAGES}${row.poster}`).kind !== "picture") return "a recording's poster must name a picture under docs/images/";
  } else if ("length" in row || "poster" in row) {
    return "only a recording carries a length and a poster";
  }
  return null;
}

/** The files under docs/images/ that the README uses, resolved from the
 * repository's root. */
function readmeImages(files, read) {
  if (!files.includes("README.md")) return [];
  return references(read("README.md"))
    .filter((ref) => ref.type === "image" && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref.target.trim()))
    .map((ref) => path.posix.normalize(decodeURIComponent(ref.target.trim().split(/[?#]/)[0])))
    .filter((file) => file.startsWith(IMAGES));
}

/**
 * Every manifest problem in the tree. `files` and `read` are as the page
 * contract takes them; `readBytes(file)` returns a file's bytes; `used` is
 * the set of files under docs/images/ the pages use, as the page contract
 * found them.
 */
export function checkManifest({ files, read, readBytes, used = new Set() }) {
  const problems = [];
  const media = files.filter((file) => ["picture", "recording"].includes(placeOf(file).kind)).sort();
  const present = new Set(media);

  let rows = [];
  if (files.includes(MANIFEST)) {
    try {
      const manifest = JSON.parse(read(MANIFEST));
      rows = Array.isArray(manifest?.rows) ? manifest.rows : [];
      if (!Array.isArray(manifest?.rows) || Object.keys(manifest).some((key) => key !== "rows")) {
        problems.push(problem(MANIFEST, "manifest.row-form", "the manifest is a set with one field, rows, a list"));
      }
    } catch { /* the page contract reports it as manifest.unreadable */ }
  }

  // Each row's form, and one row per file.
  const byFile = new Map();
  for (const row of rows) {
    if (row?.file === "manifest.json") { problems.push(problem(MANIFEST, "manifest.self-row", "the manifest has no row for itself")); continue; }
    const issue = rowIssue(row);
    if (issue) { problems.push(problem(MANIFEST, "manifest.row-form", `${row?.file ?? "a row"}: ${issue}`)); continue; }
    if (byFile.has(row.file)) { problems.push(problem(MANIFEST, "manifest.duplicate-row", `${row.file} has more than one row`)); continue; }
    byFile.set(row.file, row);
  }

  // Use: a page or the README references the file, or a recording's row
  // names it as its poster.
  const posters = new Set([...byFile.values()].filter((row) => row.kind === "recording").map((row) => `${IMAGES}${row.poster}`));
  const readme = readmeImages(files, read);
  for (const file of readme) {
    if (!present.has(file) && !files.includes(file)) problems.push(problem("README.md", "manifest.missing-file", `the README uses ${file}, which does not exist`));
    else if (!byFile.has(file.slice(IMAGES.length))) problems.push(problem("README.md", "manifest.no-row", `the README uses ${file}, which has no row in the manifest`));
  }
  const isUsed = (file) => used.has(file) || readme.includes(file) || posters.has(file);

  // Rows against files.
  for (const row of byFile.values()) {
    const file = `${IMAGES}${row.file}`;
    if (!present.has(file)) { problems.push(problem(MANIFEST, "manifest.missing-file", `${row.file} has a row but no file`)); continue; }
    if (row.kind === "recording" && !byFile.has(row.poster)) problems.push(problem(MANIFEST, "manifest.poster", `${row.file}'s poster ${row.poster} has no row`));
  }

  // Files against rows, headers and bounds.
  let recordings = 0;
  for (const file of media) {
    const kind = placeOf(file).kind;
    const bytes = Buffer.from(readBytes(file));
    const info = kind === "picture" ? webpSize(bytes) : webmInfo(bytes);
    if (kind === "recording") recordings += 1;
    if (!info) { problems.push(problem(file, "manifest.unreadable-file", `the file is not a ${kind === "picture" ? "WebP picture" : "WebM recording with a length and one video track"}`)); continue; }
    if (kind === "picture" && bytes.length > PICTURE_MAX_BYTES) problems.push(problem(file, "manifest.picture-bytes", `${bytes.length} bytes is over ${PICTURE_MAX_BYTES} for a picture`));
    if (kind === "recording" && bytes.length > RECORDING_MAX_BYTES) problems.push(problem(file, "manifest.recording-bytes", `${bytes.length} bytes is over ${RECORDING_MAX_BYTES} for a recording`));
    if (kind === "recording" && info.length > RECORDING_MAX_SECONDS) problems.push(problem(file, "manifest.recording-length", `${info.length} seconds is over ${RECORDING_MAX_SECONDS}`));
    if (!isUsed(file)) problems.push(problem(file, "manifest.unused", "no page or README uses the file, and no recording names it as its poster"));
    const row = byFile.get(file.slice(IMAGES.length));
    if (!row) { problems.push(problem(file, "manifest.no-row", "the file has no row in docs/images/manifest.json")); continue; }
    if (row.width !== info.width || row.height !== info.height) problems.push(problem(file, "manifest.dimensions", `the row says ${row.width} × ${row.height}; the file is ${info.width} × ${info.height}`));
    if (row.bytes !== bytes.length) problems.push(problem(file, "manifest.bytes", `the row says ${row.bytes} bytes; the file has ${bytes.length}`));
    if (kind === "recording" && row.length !== info.length) problems.push(problem(file, "manifest.length", `the row says ${row.length} seconds; the file lasts ${info.length}`));
    const frame = row.crop ?? FRAME;
    if (info.width !== frame.width * FRAME.scale || info.height !== frame.height * FRAME.scale) {
      problems.push(problem(file, "manifest.frame", `${info.width} × ${info.height} is not ${row.crop ? "the declared crop" : "the frame"} (${frame.width} × ${frame.height}) at ${FRAME.scale} pixels per CSS pixel`));
    }
  }
  if (recordings > RECORDINGS_MAX) problems.push(problem(IMAGES.slice(0, -1), "manifest.recording-count", `${recordings} recordings; the documentation holds at most ${RECORDINGS_MAX}`));
  return problems;
}
