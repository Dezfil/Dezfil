import { installReception, SERVER_RECEIVE_MS, withNativeReception } from "./reception.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";
import { BlockList, isIP } from "node:net";

const STATE = Symbol.for("dezfil.socket-provenance");
const STAMPED = Symbol("socket-provenance");
const RECEPTION = Symbol("native-reception");
const HEADER = "x-dezfil-ingress";
const FORWARDING = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", HEADER];
/** The streaming uploads, by method and path: their bodies take the upload
 * clock their route admits instead of the ordinary request deadline. */
const NATIVE_UPLOADS = [["POST", /^\/api\/tables\/?$/], ["PUT", /^\/api\/account\/picture\/?$/]];

export function normalizeAddress(value) {
  let address = String(value ?? "").trim();
  if (address.startsWith("[")) address = address.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1] ?? "";
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) address = address.slice(7);
  if (!isIP(address)) throw new Error("Invalid ingress address");
  if (isIP(address) !== 6) return address;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function trustedPeers(setting = "") {
  const block = new BlockList();
  for (const item of setting.split(/[\s,]+/).filter(Boolean)) {
    const [raw, prefix, extra] = item.split("/");
    const address = normalizeAddress(raw), family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix))) throw new Error("Invalid trusted proxy network");
    if (prefix === undefined) block.addAddress(address, family);
    else block.addSubnet(address, Number(prefix), family);
  }
  return address => block.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

function values(headers, name) {
  const raw = headers[name];
  if (Array.isArray(raw)) throw new Error("Ambiguous ingress header");
  return raw ? raw.split(",").map(value => value.trim()) : [];
}

function standardFields(headers) {
  return values(headers, "forwarded").map(part => {
    const fields = {};
    for (const field of part.split(";")) {
      const match = /^([a-z]+)=(?:"([^"\\]*)"|([^\s";,]+))$/i.exec(field.trim());
      if (!match || fields[match[1].toLowerCase()] !== undefined) throw new Error("Invalid Forwarded header");
      fields[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    return fields;
  });
}

function clientAddress(chain, peer, trusted) {
  const addresses = [...chain.map(normalizeAddress), peer];
  let index = addresses.length - 1;
  while (index > 0 && trusted(addresses[index])) index--;
  return addresses[index];
}

function authority(value, scheme) {
  if (!value || /[\s\\]/.test(value)) throw new Error("Invalid ingress host");
  const url = new URL(`${scheme}://${value}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid ingress host");
  return url;
}

/** Only the socket can confer proxy trust. Forwarded chains are reduced at
 * their nearest untrusted hop, before Next can fill or preserve headers. */
export function canonicalIngress(request, trusted = trustedPeers()) {
  const peer = normalizeAddress(request.socket.remoteAddress);
  const secure = request.socket.encrypted === true;
  let scheme = secure ? "https" : "http";
  let host = request.headers.host;
  let source = peer;
  let forwardedPort;
  if (trusted(peer)) {
    const standard = standardFields(request.headers);
    const chain = values(request.headers, "x-forwarded-for");
    const standardChain = standard.map(fields => fields.for);
    if (chain.length) source = clientAddress(chain, peer, trusted);
    if (standardChain.length) {
      const fromStandard = clientAddress(standardChain, peer, trusted);
      if (chain.length && source !== fromStandard) throw new Error("Conflicting forwarded source");
      source = fromStandard;
    }
    const last = standard.at(-1) ?? {};
    const forwardedHost = values(request.headers, "x-forwarded-host").at(-1);
    const forwardedProto = values(request.headers, "x-forwarded-proto").at(-1);
    if (last.host && forwardedHost && last.host !== forwardedHost) throw new Error("Conflicting forwarded host");
    if (last.proto && forwardedProto && last.proto !== forwardedProto) throw new Error("Conflicting forwarded protocol");
    host = last.host ?? forwardedHost ?? host;
    scheme = last.proto ?? forwardedProto ?? scheme;
    forwardedPort = values(request.headers, "x-forwarded-port").at(-1);
  }
  if (scheme !== "http" && scheme !== "https") throw new Error("Invalid ingress protocol");
  if (typeof host !== "string") throw new Error("Missing ingress host");
  const url = authority(host, scheme);
  if (forwardedPort !== undefined) {
    if (!/^\d+$/.test(forwardedPort) || Number(forwardedPort) < 1 || Number(forwardedPort) > 65535) throw new Error("Invalid ingress port");
    const statedPort = /:(\d+)$/.exec(host)?.[1];
    if (statedPort && Number(statedPort) !== Number(forwardedPort)) throw new Error("Conflicting forwarded port");
    url.port = forwardedPort;
  }
  return { peer, source, origin: url.origin, host: url.host,
    scheme, port: url.port || (scheme === "https" ? "443" : "80"), secure: scheme === "https" };
}

export function requireIngress(headers) {
  const state = process[STATE];
  const stamp = headers?.get(HEADER);
  if (!state || !stamp) throw new Error("The ingress preload is required");
  const [payload, signature, extra] = stamp.split(".");
  if (extra !== undefined || !payload || !/^[a-f0-9]{64}$/.test(signature ?? "")) throw new Error("Invalid ingress provenance");
  const expected = createHmac("sha256", state.key).update(payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error("Invalid ingress provenance");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Launch-time only. No identity is stamped here; handlers authenticate credentials. */
export function installIngress() {
  if (process[STATE]) return;
  const state = { key: randomBytes(32), trusted: trustedPeers(process.env.DEZFIL_TRUSTED_PROXIES ?? "") };
  Object.defineProperty(process, STATE, { value: state });
  for (const Server of [HttpServer, HttpsServer]) {
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, ...args) {
      if (event === "connection") this.requestTimeout = Math.max(this.requestTimeout, SERVER_RECEIVE_MS);
      const request = args[0];
      if (["request", "upgrade", "checkContinue", "checkExpectation"].includes(event) && !request[STAMPED]) {
        // The platform Request cannot carry TRACE, so the framework fails with
        // a logged 500 before any method dispatch. Answer it here, unread.
        if (request.method === "TRACE" && event !== "upgrade") {
          args[1].writeHead(400, { "cache-control": "private, no-store", "content-length": "0", connection: "close" }); args[1].end();
          return true;
        }
        try {
          const view = canonicalIngress(request, state.trusted);
          const payload = Buffer.from(JSON.stringify(view)).toString("base64url");
          const headers = request.headers;
          for (const name of FORWARDING) delete headers[name];
          Object.assign(headers, {
            "x-forwarded-for": view.source, "x-forwarded-host": view.host,
            "x-forwarded-proto": view.scheme, "x-forwarded-port": view.port,
            forwarded: `for="${isIP(view.source) === 6 ? `[${view.source}]` : view.source}";proto=${view.scheme};host="${view.host}"`,
            [HEADER]: `${payload}.${createHmac("sha256", state.key).update(payload).digest("hex")}`,
          });
          // Keep raw-header consumers on the same canonical view.
          const raw = request.rawHeaders;
          request.rawHeaders = raw.flatMap((value, index) => index % 2 === 0 && !FORWARDING.includes(value.toLowerCase()) ? [value, raw[index + 1]] : []);
          for (const name of FORWARDING) request.rawHeaders.push(name, headers[name]);
          const pathname = new URL(request.url ?? "/", view.origin).pathname;
          if (event !== "upgrade") {
            const upload = NATIVE_UPLOADS.some(([method, shape]) => request.method === method && shape.test(pathname));
            request[RECEPTION] = installReception(this, request, args[1], upload);
          }
          request[STAMPED] = true;
        } catch {
          const response = args[1];
          if (event === "upgrade") response.end("HTTP/1.1 400 Bad Request\r\nCache-Control: private, no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          else { response.writeHead(400, { "cache-control": "private, no-store", "content-type": "application/json", connection: "close" }); response.end('{"error":{"code":"invalid_request","message":"Invalid request provenance."}}'); }
          return true;
        }
      }
      const reception = request?.[RECEPTION];
      return reception ? withNativeReception(reception, () => emit.call(this, event, ...args)) : emit.call(this, event, ...args);
    };
  }
}
