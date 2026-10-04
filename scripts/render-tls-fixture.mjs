import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { active, fixtureLog } from './render-egress-log.mjs';
import { tile } from './render-style-fixture.mjs';
const log = fixtureLog(`${process.env.PROBE_EVIDENCE}/tls.ndjson`);
const certificate = active().certificate ?? 'trusted';
const server = createServer({ key: readFileSync(`/trust/${certificate}.key`), cert: readFileSync(`/trust/${certificate}.pem`) }, (request, response) => {
  const state = active(), pathname = new URL(request.url, 'https://tls.render.test').pathname;
  log({ event: 'request', phase: state.phase, path: pathname, sni: request.socket.servername, from: request.socket.remoteAddress, port: request.socket.remotePort });
  let type = 'text/plain', body = 'missing', status = 404;
  if (pathname === '/style.json') {
    status = 200; type = 'application/json';
    body = JSON.stringify({ version: 8, sources: { raster: { type: 'raster', tiles: ['https://tls.render.test:8443/tiles/{z}/{x}/{y}.png'], tileSize: 256 } }, layers: [{ id: 'raster', type: 'raster', source: 'raster', paint: { 'raster-fade-duration': 0 } }] });
  } else if (pathname.startsWith('/tiles/')) { status = 200; type = 'image/png'; body = tile; }
  else if (pathname === '/scripted.html') {
    status = 200; type = 'text/html'; body = '<!doctype html><title>Scripted browser transport fixture</title><link rel="icon" href="/favicon.ico"><p>Scripted transport stimulus</p>';
  } else if (pathname === '/sw.js') {
    status = 200; type = 'text/javascript'; body = "self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil((async () => { await self.clients.claim(); await fetch('/sw-fetch'); })()));";
  } else if (['/sw-fetch', '/favicon.ico'].includes(pathname)) { status = 200; body = 'fixture'; }
  response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'access-control-allow-origin': '*', connection: 'close' });
  response.end(body);
});
server.on('secureConnection', socket => log({ event: 'secure', phase: active().phase, sni: socket.servername, from: socket.remoteAddress, port: socket.remotePort }));
server.on('tlsClientError', error => log({ event: 'tls-error', phase: active().phase, message: error.message }));
server.on('upgrade', (request, socket) => {
  log({ event: 'websocket', phase: active().phase, sni: request.socket.servername, path: request.url });
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('error', () => {}); socket.on('data', () => socket.end());
});
server.listen(8443, '0.0.0.0', () => log({ event: 'ready' }));
