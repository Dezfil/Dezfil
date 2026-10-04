import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
export function storeFiles(directory, prefix = '') {
  return readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'proof store contains no symbolic links');
    return entry.isDirectory() ? storeFiles(directory, file) : [file];
  }).sort();
}
/** Scan every live file, including SQLite sidecars, with bounded buffers. */
export function scanStore(directory, sentinels) {
  const needles = sentinels.map(value => Buffer.from(value));
  assert.ok(needles.length && needles.every(value => value.length), 'nonempty sentinel ledger');
  const hits = Object.fromEntries(sentinels.map(value => [value, []]));
  const overlap = Math.max(...needles.map(value => value.length)) - 1;
  for (const file of storeFiles(directory)) {
    const fd = openSync(path.join(directory, file), 'r'), chunk = Buffer.alloc(65536);
    let tail = Buffer.alloc(0);
    try {
      for (;;) {
        const length = readSync(fd, chunk); if (!length) break;
        const bytes = Buffer.concat([tail, chunk.subarray(0, length)]);
        needles.forEach((needle, i) => { if (bytes.includes(needle) && !hits[sentinels[i]].includes(file)) hits[sentinels[i]].push(file); });
        tail = bytes.subarray(Math.max(0, bytes.length - overlap));
      }
    } finally { closeSync(fd); }
  }
  return hits;
}
export function writeProofFile(directory, file, value) {
  mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  writeFileSync(path.join(directory, file), value);
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function fileLedger(directory, files) { return Object.fromEntries(files.map(file => [file, digest(readFileSync(path.join(directory, file)))])); }
export function plantImages(directory, mapId, dataset, prefix) {
  const files = [];
  for (const theme of ['light', 'dark']) {
    const name = `${mapId}.proof.${theme}.png`, bytes = Buffer.from(`${prefix}-${theme}`);
    writeProofFile(directory, `thumbnails/${name}`, bytes);
    writeProofFile(directory, `artifact-inputs/thumbnails/${name}.json`, JSON.stringify({ sha256: digest(bytes), inputs: { catalogue: false, datasets: [{ id: dataset.id, file: dataset.file }] } }));
    files.push(`thumbnails/${name}`, `artifact-inputs/thumbnails/${name}.json`);
  }
  const manifest = `thumbnails/${mapId}.json`;
  writeProofFile(directory, manifest, JSON.stringify({ light: `${mapId}.proof.light.png`, dark: `${mapId}.proof.dark.png` }));
  return [...files, manifest];
}
export function assertErased(directory, ledger) {
  const files = storeFiles(directory);
  for (const file of ledger.removedFiles) assert.ok(!files.includes(file), `recorded derivative or owned file remains: ${file}`);
  const hits = scanStore(directory, ledger.erased);
  for (const [sentinel, files] of Object.entries(hits)) assert.equal(files.length, 0, `live erased sentinel remains (${ledger.erased.indexOf(sentinel)}): ${files.join(', ')}`);
  for (const files of Object.values(scanStore(directory, ledger.retained))) assert.ok(files.length, 'control sentinel remains');
  assert.deepEqual(fileLedger(directory, Object.keys(ledger.controlFiles)), ledger.controlFiles, 'independent artifact bytes unchanged');
}
