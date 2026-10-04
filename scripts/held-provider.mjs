import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export const placeRows = [{ name: 'Harbour', display_name: 'Harbour, Fixture coast', lat: '52.5', lon: '13.4', licence: 'Fixture credit' }];
export const style = { version: 8, name: 'Fixture style', sources: { coast: { type: 'vector', tiles: ['https://example.test/{z}/{x}/{y}.pbf'], attribution: 'Fixture credit' } }, layers: [{ id: 'background', type: 'background' }] };
export const pause = delay;
export async function until(predicate, message, timeout = 3_000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start >= timeout) throw new Error(message);
    await delay(5);
  }
}

/** Each arm owns its sockets. Closure is recorded at the provider, before cleanup. */
export async function heldProvider(port = 4319) {
  const arms = new Map(), sockets = new Set();
  let connectionCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const id = url.searchParams.get('q') ?? url.pathname.split('/').at(-1);
    const arm = arms.get(id);
    if (!arm) { res.writeHead(404, { connection: 'close' }); res.end(); return; }
    const hop = Number(url.searchParams.get('hop') ?? 0);
    const record = { hop, arrivedAt: performance.now(), closedAt: null, cleanup: false, socket: req.socket, response: res };
    arm.requests.push(record);
    req.socket.once('close', () => { record.closedAt = performance.now(); });
    if (arm.phase === 'redirect' && hop === 0) {
      url.searchParams.set('hop', '1');
      res.writeHead(302, { location: url.pathname + url.search, connection: 'close' });
      res.write('held redirect body');
      return;
    }
    const body = JSON.stringify(arm.road === 'search' ? placeRows : style);
    if (arm.phase === 'normal') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(body);
    } else if (arm.phase === 'body') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.write(body.slice(0, 10));
    }
    arm.held = record;
  });
  server.on('connection', socket => {
    connectionCount++; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    connections: () => connectionCount,
    arm(road, phase, id) {
      assert.ok(!arms.has(id), `Duplicate arm ${id}`);
      const arm = { id, road, phase, requests: [], held: null, url: `${origin}/style/${id}` };
      arms.set(id, arm); return arm;
    },
    release(arm) {
      for (const request of arm.requests) {
        if (request.closedAt === null) { request.cleanup = true; request.socket.destroy(); }
      }
    },
    async close() {
      for (const arm of arms.values()) this.release(arm);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function evidence(arm) {
  return arm.requests.map(({ hop, arrivedAt, closedAt, cleanup }) => ({ hop, arrivedAt, closedAt, cleanup }));
}

export async function assertClosed(arm, departedAt) {
  assert.ok(arm.held, `${arm.id}: held destination was observed`);
  await until(() => arm.requests.every(r => r.closedAt !== null), `${arm.id}: provider socket stayed open more than 1000 ms after client abort`, 1_050);
  for (const r of arm.requests) {
    assert.equal(r.cleanup, false, `${arm.id}: teardown cannot prove closure`);
    assert.ok(r.closedAt - departedAt <= 1_000, `${arm.id}: provider closed ${r.closedAt - departedAt} ms after client abort (limit 1000 ms)`);
  }
}
