// Passive observation of bytes on the app process's accepted loopback socket.
// No fixture counter, relay callback, socket reads or additional data listener.
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';

export function inspectSocksStream(input, output) {
  if (input.length < 2 || input[0] !== 5) return null;
  const greeting = 2 + input[1];
  if (input.length < greeting + 5) return null;
  const request = input.subarray(greeting);
  if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) throw Error('invalid observed CONNECT');
  const type = request[3];
  const size = type === 3 ? request[4] : type === 1 ? 4 : type === 4 ? 16 : 0;
  if (!size) throw Error('unknown observed address type');
  const start = type === 3 ? 5 : 4, end = start + size;
  if (request.length < end + 2) return null;
  const host = type === 3 ? request.toString('ascii', start, end) : type === 1 ? [...request.subarray(start, end)].join('.') : request.subarray(start, end).toString('hex');
  const port = request.readUInt16BE(end);
  if (output.length < 6 || output[0] !== 5 || output[1] !== 0) return null;
  const reply = output.subarray(2), replySize = reply[3] === 1 ? 10 : reply[3] === 4 ? 22 : reply[3] === 3 ? 7 + reply[4] : 0;
  if (!replySize || reply.length < replySize || reply[1] !== 0) return null;
  const identity = { host, port, connected: true };
  const http = request.subarray(end + 2).toString('latin1');
  const path = /^GET (\/[^ ]*) HTTP\/1\.[01]\r\n/.exec(http)?.[1];
  if (!path) return identity; // TLS and WebSocket payloads remain opaque.
  const response = reply.subarray(replySize), headEnd = response.indexOf('\r\n\r\n');
  if (headEnd < 0) return identity;
  const head = response.toString('latin1', 0, headEnd);
  const length = /\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1];
  if (!length || response.length < headEnd + 4 + Number(length)) return identity;
  return { ...identity, path, status: Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1]),
    bytes: Number(length), sha256: createHash('sha256').update(response.subarray(headEnd + 4, headEnd + 4 + Number(length))).digest('hex') };
}

export function observeRoad(log) {
  const ports = new Set(), streams = new WeakMap();
  let serial = 0;
  function record(socket, chunk, direction) {
    if (!ports.has(socket.localPort) || !['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)) return;
    let stream = streams.get(socket);
    if (!stream) {
      stream = { id: ++serial, input: Buffer.alloc(0), output: Buffer.alloc(0), connected: false, complete: false };
      streams.set(socket, stream);
    }
    if (stream.complete) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stream[direction].length + bytes.length > 2 * 1024 * 1024) { stream.complete = true; log({ event: 'road-error', message: 'stream observation bound exceeded' }); return; }
    stream[direction] = Buffer.concat([stream[direction], bytes]);
    try {
      const observed = inspectSocksStream(stream.input, stream.output);
      const identity = { stream: stream.id, localPort: socket.localPort, remotePort: socket.remotePort };
      if (observed && !stream.connected) { stream.connected = true; log({ event: 'socks-connect', ...identity, host: observed.host, port: observed.port }); }
      if (observed?.path) { stream.complete = true; log({ event: 'road-response', ...identity, ...observed }); }
    } catch (error) { stream.complete = true; log({ event: 'road-error', message: error.message }); }
  }
  const emit = Socket.prototype.emit, write = Socket.prototype.write;
  Socket.prototype.emit = function (event, ...args) {
    if (event === 'data') record(this, args[0], 'input');
    return emit.call(this, event, ...args);
  };
  Socket.prototype.write = function (chunk, ...args) {
    record(this, chunk, 'output');
    return write.call(this, chunk, ...args);
  };
  log({ event: 'ready' });
  return flags => {
    const proxy = flags.find(flag => flag.startsWith('--proxy-server=socks5://127.0.0.1:'));
    if (proxy) { const port = Number(proxy.split(':').at(-1)); ports.add(port); log({ event: 'road-listener', port }); }
  };
}
