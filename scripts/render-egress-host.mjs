import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { active, fixtureLog } from './render-egress-log.mjs';
import { fixtureResponse } from './render-style-fixture.mjs';

const role = process.env.PROBE_ROLE;
const log = fixtureLog(`${process.env.PROBE_EVIDENCE}/${role}.ndjson`);
let serial = 0;
const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store', connection: 'close' };
const server = createServer((request, response) => {
  const state = active(), url = new URL(request.url, 'http://fixture.test');
  log({ event: 'request', arm: state.id, phase: state.phase, socket: request.socket.probeId, path: url.pathname, host: request.headers.host });
  const payload = url.pathname === '/intermediate.der' && state.kind === 'tls'
    ? { status: state.blockAia ? 503 : 200, type: 'application/pkix-cert', body: state.blockAia ? 'blocked' : readFileSync('/trust/intermediate.der') }
    : fixtureResponse(state, url.pathname, role);
  response.on('finish', () => log({ event: 'response', arm: state.id, phase: state.phase,
    socket: request.socket.probeId, path: url.pathname, status: payload.status }));
  response.writeHead(payload.status, { ...headers, 'content-type': payload.type, 'content-length': Buffer.byteLength(payload.body), ...(payload.location ? { location: payload.location } : {}) });
  response.end(payload.body);
});
server.on('connection', socket => {
  const state = active(); socket.probeId = ++serial;
  const identity = { arm: state.id, phase: state.phase, socket: socket.probeId };
  log({ event: 'connection', ...identity, from: socket.remoteAddress });
  socket.on('close', () => log({ event: 'close', ...identity }));
});
server.listen(role === 'local' ? 3188 : 8080, '::', () => log({ event: 'ready' }));
