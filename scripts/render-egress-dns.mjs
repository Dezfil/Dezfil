// Isolated UDP name service; every question and answer is durable evidence.
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { fixtureLog } from './render-egress-log.mjs';
import { publicAddress, privateAddress } from './render-egress-assert.mjs';

const directory = process.env.PROBE_EVIDENCE;
const log = fixtureLog(`${directory}/dns.ndjson`);
const counts = new Map();
const socket = dgram.createSocket('udp4');
socket.on('message', (packet, remote) => {
  try {
    const state = JSON.parse(readFileSync(`${directory}/active.json`, 'utf8'));
    let offset = 12;
    const labels = [];
    while (packet[offset]) {
      const length = packet[offset++];
      if (length > 63 || offset + length > packet.length) throw new Error('invalid DNS question');
      labels.push(packet.toString('ascii', offset, offset + length)); offset += length;
    }
    offset++;
    const name = labels.join('.').toLowerCase(), type = packet.readUInt16BE(offset);
    offset += 4;
    const key = `${state.id}:${state.phase}:${name}`;
    const n = type === 1 ? (counts.get(key) ?? 0) + 1 : counts.get(key) ?? 0;
    if (type === 1) counts.set(key, n);
    const known = name === state.author || name === state.root;
    const mode = state.phase === 'render' && name === state.author ? state.mode : 'public';
    const dead = mode === 'dead' || (mode === 'public-dead' && n > 1);
    const address = mode === 'private' || (mode === 'rebind' && n > 1) ? privateAddress : publicAddress;
    const answers = known && !dead && type === 1 ? [address] : [];
    const rcode = !known || dead ? 3 : 0;
    const header = Buffer.alloc(12);
    packet.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180 | rcode, 2);
    header.writeUInt16BE(1, 4); header.writeUInt16BE(answers.length, 6);
    const records = answers.map(ip => {
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(1, 2); record.writeUInt16BE(1, 4);
      record.writeUInt16BE(4, 10); ip.split('.').forEach((octet, i) => { record[12 + i] = Number(octet); });
      return record;
    });
    log({ event: 'query', arm: state.id, phase: state.phase, name, type, n, answers, rcode, from: remote.address });
    socket.send(Buffer.concat([header, packet.subarray(12, offset), ...records]), remote.port, remote.address);
  } catch (error) { log({ event: 'error', message: error.message }); }
});
socket.bind(53, '0.0.0.0', () => log({ event: 'ready' }));
