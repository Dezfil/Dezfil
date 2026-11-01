import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
export const MB = 1024 * 1024, THRESHOLD = 512 * MB, RESERVE = 64 * MB;
export const freeBytes = (folder, io = fs) => { const s = io.statfsSync(folder); return s.bavail * s.bsize; };
export function boundedVolume(folder, io = fs) {
  const s = io.statfsSync(folder), total = s.blocks * s.bsize;
  assert.ok(total >= 1024 * MB && total <= 2048 * MB, `Refusing to fill a volume outside 1–2 GB: ${total}`);
  return total;
}
export async function until(read, accepts, message, ms = 45_000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (accepts(value)) return value; await pause(25); } while (Date.now() < end);
  throw new Error(message);
}
/** Allocate actual blocks until even one filesystem block is refused. Never truncate upward. */
export function fillVolume(folder, name = '.storage-probe-hog', io = fs) {
  boundedVolume(folder, io);
  const fd = io.openSync(path.join(folder, name), 'a'), block = Buffer.alloc(MB, 0x61);
  let bytes = 0, refused = false;
  try {
    for (const size of [MB, 4096]) {
      for (;;) {
        try { bytes += io.writeSync(fd, block, 0, size); }
        catch (error) { if (error.code !== 'ENOSPC') throw error; refused = true; break; }
      }
    }
  } finally { io.closeSync(fd); }
  assert.ok(refused, 'The filesystem must refuse a real allocation');
  assert.ok(freeBytes(folder, io) < 4096, 'The volume must have no writable block left');
  return bytes;
}
export function jsonFile(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback; throw error; } }
export function lines(file) { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
export function noSpace(answer) {
  assert.equal(answer.status, 507, JSON.stringify(answer));
  assert.equal(answer.json?.error?.code, 'storage_exhausted', JSON.stringify(answer));
  assert.match(answer.json.error.message, /^This instance's storage is full: .+ free of .+\. Delete datasets or maps you no longer need, or ask an admin to free space\.$/);
}
/** A declared upload held after its first MB, before its declared end. */
export function heldUpload(base, cookie, fileBytes = 128 * MB) {
  const boundary = 'storage-probe-boundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="overlap.csv"\r\nContent-Type: text/csv\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunk = Buffer.alloc(MB, 0x61); chunk[chunk.length - 1] = 10;
  let answered = false, sent = chunk.length;
  const result = Promise.withResolvers();
  const request = http.request(new URL('/api/tables', base), { method: 'POST', headers: { cookie, origin: base,
    'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': head.length + fileBytes + tail.length } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => { answered = true; try { result.resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { result.reject(error); } request.destroy(); });
  });
  request.on('error', error => { if (!answered) result.reject(error); });
  // Observe immediately: an admission refusal may arrive before the caller awaits it.
  void result.promise.catch(() => {});
  request.write(head); request.write(chunk);
  return { result: result.promise, close: () => request.destroy(),
    async finish() {
      while (sent < fileBytes && !answered && !request.destroyed) {
        const count = Math.min(chunk.length, fileBytes - sent); sent += count;
        if (!request.write(chunk.subarray(0, count))) await Promise.race([new Promise(resolve => request.once('drain', resolve)), result.promise]);
      }
      if (!answered && !request.destroyed) request.end(tail);
      return result.promise;
    },
  };
}
/** A loopback source for a link dataset. Held, it declares a large file and stops after its first MB. */
export async function heldSource() {
  const rows = 'id,lon,lat\n' + Array.from({ length: 40 }, (_, i) => `${i},${13.3 + i / 1000},52.5`).join('\n');
  let body = rows, held = null, requested = Promise.withResolvers();
  const server = http.createServer(async (request, response) => {
    if (!held) { response.setHeader('content-length', Buffer.byteLength(body)); response.end(body); return; }
    const { gate } = held, chunk = Buffer.alloc(MB, 0x61), declared = 64;
    response.setHeader('content-length', declared * MB);
    response.write(chunk);
    requested.resolve();
    await gate.promise;
    for (let sent = 1; sent < declared && !response.destroyed; sent++) {
      if (!response.write(chunk)) await new Promise(resolve => { response.once('drain', resolve); response.once('close', resolve); });
    }
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: name => `http://127.0.0.1:${port}/${name}`,
    hold() { held = { gate: Promise.withResolvers() }; requested = Promise.withResolvers(); },
    get requested() { return requested.promise; },
    release() { const was = held; held = null; was?.gate.resolve(); },
    serve(text) { body = text; },
    close() { held?.gate.resolve(); server.closeAllConnections(); server.close(); },
  };
}
export function partialFiles(folder) {
  const roots = ['tmp', 'tiles/scratch', 'exports'];
  return roots.flatMap(root => {
    const at = path.join(folder, root); if (!fs.existsSync(at)) return [];
    return fs.readdirSync(at, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(folder, path.join(e.parentPath, e.name)));
  }).sort();
}
