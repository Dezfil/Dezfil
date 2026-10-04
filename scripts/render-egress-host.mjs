import { createServer } from 'node:http';
import { active, fixtureLog } from './render-egress-log.mjs';

const role = process.env.PROBE_ROLE;
const log = fixtureLog(`${process.env.PROBE_EVIDENCE}/${role}.ndjson`);
let serial = 0;
const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store', connection: 'close' };
const server = createServer((request, response) => {
  const state = active(), url = new URL(request.url, 'http://fixture.test');
  log({ event: 'request', arm: state.id, phase: state.phase, socket: request.socket.probeId, path: url.pathname, host: request.headers.host });
  const finish = (type, body, status = 200) => {
    response.writeHead(status, { ...headers, 'content-type': type }); response.end(body);
  };
  if (url.pathname === '/live') return finish('text/plain', 'listener-alive');
  if (role === 'listener' && state.variant === 'blind') return finish('text/plain', 'internal-service-body');
  if (url.pathname === '/style.json') return finish('application/json', JSON.stringify({
    version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: {
      'background-color': role === 'listener' ? '#ff00ff' : '#00c8d8',
    } }],
  }));
  finish('text/plain', 'missing', 404);
});
server.on('connection', socket => {
  const state = active(); socket.probeId = ++serial;
  const identity = { arm: state.id, phase: state.phase, socket: socket.probeId };
  log({ event: 'connection', ...identity, from: socket.remoteAddress });
  socket.on('close', () => log({ event: 'close', ...identity }));
});
server.listen(8080, '0.0.0.0', () => log({ event: 'ready' }));
