// The image manifest, docs/images/manifest.json, as the picture script
// writes it: one row per picture and recording, none for itself. A file is
// replaced only when its bytes changed, and a row's version and date move
// only with its file, so a run that changed nothing changes no file and no
// row, and a diff after a run shows real changes and nothing else.

export const MANIFEST = "docs/images/manifest.json";

/** A row in its fixed key order: what the scene is, when it was taken,
 * the file's size, then what only some rows carry. Sizes are pixels and
 * bytes; a crop is the CSS-pixel rectangle the picture shows. */
export function manifestRow(item, taken) {
  return {
    file: item.file,
    scene: item.scene,
    kind: item.kind,
    version: taken.version,
    date: taken.date,
    width: item.width,
    height: item.height,
    bytes: item.bytes.length,
    ...(item.crop ? { crop: item.crop } : {}),
    ...(item.length !== undefined ? { length: item.length } : {}),
    ...(item.poster ? { poster: item.poster } : {}),
  };
}

export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/**
 * What a run writes, from what it captured and what is on disk.
 *
 * `manifest` is the committed manifest or null; `captured` lists every file
 * the run made, `{ scene, kind, file, bytes, width, height, crop?, length?,
 * poster? }`; `current(file)` returns the bytes on disk under docs/images/
 * or null; `scenes` is the scene list; `partial` is true when the run took
 * only some scenes, so the rows of the others stay as they are.
 *
 * Returns the files to write, the files to remove (a scene that left the
 * list, or a file a scene no longer makes) and the manifest to keep.
 */
export function planRun({ manifest, captured, current, scenes, partial = false, version, date }) {
  const before = new Map((manifest?.rows ?? []).map((row) => [row.file, row]));
  const known = new Set(scenes.map((scene) => scene.id));
  const taken = new Set(captured.map((item) => item.scene));
  const made = new Set(captured.map((item) => item.file));
  const rows = new Map();
  const removes = [];
  for (const row of before.values()) {
    const keep = taken.has(row.scene) ? made.has(row.file) : known.has(row.scene) || partial;
    if (taken.has(row.scene) && made.has(row.file)) continue; // replaced below
    if (keep) rows.set(row.file, row);
    else removes.push(row.file);
  }
  const writes = [];
  for (const item of captured) {
    const old = current(item.file);
    const same = old !== null && Buffer.compare(Buffer.from(old), Buffer.from(item.bytes)) === 0;
    const earlier = before.get(item.file);
    rows.set(item.file, manifestRow(item, same && earlier ? earlier : { version, date }));
    if (!same) writes.push({ file: item.file, bytes: item.bytes });
  }
  return { writes, removes: removes.sort(), manifest: { rows: [...rows.values()].sort(byFile) } };
}
