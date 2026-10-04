import { isIP } from "node:net";

export interface SocksTarget { host: string; port: number }
export class SocksProtocolError extends Error {
  constructor(readonly reply?: Buffer) { super("Invalid SOCKS negotiation"); }
}
export const socksReply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** Only framing is buffered: at most 262 bytes, independent of TCP chunking.
 * Bytes after CONNECT belong to the tunnel and are handed back untouched. */
export class SocksHandshake {
  private readonly frame = Buffer.alloc(262);
  private length = 0;
  private greeting = true;
  private done = false;

  push(chunk: Buffer): { replies: Buffer[]; target?: SocksTarget; rest?: Buffer } {
    if (this.done) throw new SocksProtocolError();
    const replies: Buffer[] = [];
    for (let offset = 0; offset < chunk.length; offset++) {
      this.frame[this.length++] = chunk[offset];
      const b = this.frame, n = this.length;
      if (n === 1 && b[0] !== 5) throw new SocksProtocolError();
      if (this.greeting) {
        if (n === 2 && b[1] === 0) throw new SocksProtocolError(Buffer.from([5, 255]));
        if (n < 2 || n < 2 + b[1]) continue;
        if (!b.subarray(2, n).includes(0)) throw new SocksProtocolError(Buffer.from([5, 255]));
        replies.push(Buffer.from([5, 0]));
        this.greeting = false;
        this.length = 0;
        continue;
      }
      if (n === 2 && b[1] !== 1) throw new SocksProtocolError(socksReply(7));
      if (n === 3 && b[2] !== 0) throw new SocksProtocolError(socksReply(1));
      if (n < 4) continue;
      const type = b[3];
      if (type !== 1 && type !== 3 && type !== 4) throw new SocksProtocolError(socksReply(8));
      if (type === 3 && n < 5) continue;
      if (type === 3 && b[4] === 0) throw new SocksProtocolError(socksReply(8));
      const end = type === 1 ? 8 : type === 4 ? 20 : 5 + b[4];
      if (n < end + 2) continue;
      let host: string;
      if (type === 1) host = [...b.subarray(4, 8)].join(".");
      else if (type === 4) host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(4 + i * 2).toString(16)).join(":");
      else {
        host = b.toString("latin1", 5, end);
        // Domain-form IP literals get the same policy as binary literals.
        if (!isIP(host) && !(host.length <= 253 && host.replace(/\.$/, "").split(".")
          .every((label) => /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$/.test(label)))) {
          throw new SocksProtocolError(socksReply(8));
        }
      }
      const port = b.readUInt16BE(end);
      if (!port) throw new SocksProtocolError(socksReply(1));
      this.done = true;
      return { replies, target: { host, port }, rest: chunk.subarray(offset + 1) };
    }
    return { replies };
  }
}
