import { describe, expect, it } from "vitest";
import { SocksHandshake } from "./render-socks";

const hello = Buffer.from([5, 1, 0]);
const request = Buffer.from([5, 1, 0, 3, 9, ...Buffer.from("host.test"), 1, 187]);

describe("bounded SOCKS negotiation", () => {
  it("accepts every fragmentation boundary and coalesced application bytes", () => {
    const wire = Buffer.concat([hello, request]);
    for (let split = 0; split <= wire.length; split++) {
      const parser = new SocksHandshake();
      const first = parser.push(wire.subarray(0, split));
      const second = first.target ? first : parser.push(wire.subarray(split));
      expect(second.target).toEqual({ host: "host.test", port: 443 });
      expect([...first.replies, ...(second === first ? [] : second.replies)]).toEqual([Buffer.from([5, 0])]);
    }
    const payload = Buffer.alloc(256 * 1024, 42);
    const parsed = new SocksHandshake().push(Buffer.concat([wire, payload]));
    expect(parsed.rest).toEqual(payload);
  });

  it("accepts bytewise negotiation, IPv4 and IPv6 targets", () => {
    for (const [target, host] of [
      [Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]), "127.0.0.1"],
      [Buffer.from([5, 1, 0, 4, ...Buffer.alloc(15), 1, 0, 80]), "0:0:0:0:0:0:0:1"],
    ] as const) {
      const parser = new SocksHandshake();
      let result;
      for (const byte of Buffer.concat([hello, target])) result = parser.push(Buffer.from([byte]));
      expect(result?.target).toEqual({ host, port: 80 });
    }
  });

  it.each([
    [71], [4], [5, 0], [5, 1, 2],
    [...hello, 4, 1, 0, 1], [...hello, 5, 2, 0, 1], [...hello, 5, 3, 0, 1],
    [...hello, 5, 1, 1, 1], [...hello, 5, 1, 0, 9], [...hello, 5, 1, 0, 3, 0],
    [...hello, 5, 1, 0, 1, 127, 0, 0, 1, 0, 0],
    [...hello, 5, 1, 0, 3, 3, 97, 0, 98, 0, 80],
    [...hello, 5, 1, 0, 3, 3, 97, 255, 98, 0, 80],
    [...hello, 5, 1, 0, 3, 3, 97, 47, 98, 0, 80],
  ])("refuses malformed/unsupported framing %j", (...bytes) => {
    expect(() => new SocksHandshake().push(Buffer.from(bytes))).toThrow();
  });

  it("bounds unfinished framing to the protocol's length fields", () => {
    const parser = new SocksHandshake();
    expect(parser.push(Buffer.from([5, 255, ...Buffer.alloc(254, 2)]))).not.toHaveProperty("target");
    expect(() => parser.push(Buffer.alloc(100_000, 2))).toThrow();
    const name = "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(61);
    expect(new SocksHandshake().push(Buffer.from([...hello, 5, 1, 0, 3, 253, ...Buffer.from(name), 0, 80])).target)
      .toEqual({ host: name, port: 80 });
  });
});
