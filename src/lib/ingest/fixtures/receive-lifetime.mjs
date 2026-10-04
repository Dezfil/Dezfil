import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const [bundle, mode, boundary] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const globalRejections = [];
process.on("unhandledRejection", (error) => globalRejections.push(String(error)));
const dir = await mkdtemp(path.join(bundle, ".tmp-case-"));
process.env.DEZFIL_DATA_DIR = dir;
process.env.DEZFIL_UPLOAD_MAX_MB = "1";
const destinations = [];
let recovering = false;
let finishWrite;
let secondaryCancellation = false;
let destinationsCreated = 0;
let writeHeld;
const firstWriteHeld = new Promise((resolve) => { writeHeld = resolve; });
const originalCreate = fs.createWriteStream;

// The delayed destroy writes real bytes before acknowledging close, modelling
// an outstanding disk operation. Unlink-before-close visibly recreates a file.
class ControlledFile extends Writable {
  constructor(target) {
    super();
    this.target = target;
    this.chunks = [];
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    if (mode !== "delayed-success") fs.writeFileSync(this.target, Buffer.concat(this.chunks));
    if (mode === "write-error") finishWrite = () => callback(new Error("fixture disk failure"));
    // A disk slower than the network: the first write stays unacknowledged, so
    // the part is paused and keeps what the parser hands it next.
    else if (mode === "size-limit-at-closing-boundary") writeHeld();
    else callback();
  }
  _final(callback) {
    setTimeout(() => {
      if (mode === "delayed-success") fs.writeFileSync(this.target, Buffer.concat(this.chunks));
      callback(mode === "flush-error" ? new Error("fixture flush failure") : null);
    }, 60);
  }
  _destroy(error, callback) {
    if (mode.includes("delayed-close")) {
      setTimeout(() => {
        fs.writeFileSync(this.target, Buffer.concat(this.chunks));
        callback(error);
      }, 80);
    } else callback(error);
  }
}
fs.createWriteStream = (target) => {
  destinationsCreated++;
  const destination = !recovering && ["write-error", "flush-error", "delayed-success", "source-error-delayed-close", "abort-delayed-close", "source-error-then-abort-delayed-close", "size-limit-at-closing-boundary"].includes(mode)
    ? new ControlledFile(target) : originalCreate(target);
  destinations.push(destination);
  return destination;
};

const parsers = [];
const busboyPath = require.resolve("busboy");
const originalBusboy = require(busboyPath);
require.cache[busboyPath].exports = (options) => {
  const parser = originalBusboy(options);
  parsers.push(parser);
  return parser;
};

const { receiveUpload } = require(path.join(bundle, "src/lib/ingest/receive.cjs"));
const { accountFiles, removeAccountFile } = require(path.join(bundle, "src/lib/ingest/file-ownership.cjs"));
const { errorResponse } = require(path.join(bundle, "src/lib/api/errors.cjs"));
const { POST } = require(path.join(bundle, "src/app/api/tables/route.cjs"));
const ingest = require(path.join(bundle, "src/lib/ingest/gdal-formats.cjs"));
const controller = new AbortController();
let source;
let sourceSettled = false;
const contents = "x,y\n" + "1,2\n".repeat(2048);
const part = '--owned\r\nContent-Disposition: form-data; name="file"; filename="points.csv"\r\nContent-Type: text/csv\r\n\r\n';
const ending = "\r\n--owned--\r\n";
const nodeBody = mode.startsWith("node-");
let chunksProduced = 0;
const totalChunks = 48;
let nodeTimer;
const body = nodeBody ? new Readable({
  read() {
    if (nodeTimer) return;
    this.push(Buffer.from(mode === "node-wrong-field" ? part.replace('name="file"', 'name="data"') : part));
    nodeTimer = setInterval(() => {
      chunksProduced++;
      this.push(Buffer.alloc(64 * 1024, "x"));
      if (chunksProduced === totalChunks) {
        clearInterval(nodeTimer);
        this.push(Buffer.from(ending));
        this.push(null);
      }
    }, 5);
  },
  destroy(error, callback) {
    clearInterval(nodeTimer);
    callback(error);
  },
}) : new ReadableStream({
  start(value) { source = value; },
  async cancel() {
    if (mode === "abort-delayed-cancel") await delay(80);
    sourceSettled = true;
    if (mode === "write-error") {
      secondaryCancellation = true;
      throw new Error("secondary source cancellation failure");
    }
  },
});
if (nodeBody) body.once("close", () => { sourceSettled = true; });
function end() { sourceSettled = true; source.close(); }
function sourceError() { sourceSettled = true; source.error(new Error("fixture source interruption")); }
const request = new Request("http://dezfil.test/api/tables", {
  method: "POST", signal: controller.signal, body, duplex: "half",
  headers: { "content-type": mode === "missing-boundary" ? "multipart/form-data" : "multipart/form-data; boundary=owned" },
});
const files = async () => readdir(path.join(dir, "tmp")).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
async function partial() {
  for (let n = 0; n < 100; n++) {
    for (const name of await files()) {
      const bytes = await readFile(path.join(dir, "tmp", name));
      if (bytes.length) return bytes.length;
    }
    await delay(5);
  }
  throw new Error("fixture never observed partial bytes before interruption");
}
async function receive(request) {
  if (boundary === "route") {
    const response = await POST(request);
    const body = await response.text();
    const parsed = body ? JSON.parse(body) : null;
    return { status: response.status, body, code: parsed?.error?.code ?? null, message: parsed?.error?.message,
      ...(response.status === 201 ? ingest.calls.at(-1) : {}) };
  }
  try {
    const received = await receiveUpload(request, "upload-fixture");
    const bytes = await readFile(received.tmpPath, "utf8");
    await removeAccountFile(received.tmpPath);
    return { status: 201, filename: received.filename, bytes };
  } catch (error) {
    // Use the real mapper for the receiver's coded outcome and bodiless 499.
    const response = errorResponse(error);
    const body = await response.text();
    const parsed = body ? JSON.parse(body) : null;
    return { status: response.status, body, code: parsed?.error?.code ?? null, message: parsed?.error?.message };
  }
}

let partialBytes = 0;
let settledSnapshot;
const pending = receive(request).then(async (result) => {
  settledSnapshot = {
    sourceSettled, parserClosedAtSettlement: parsers.every((p) => p.closed), destinationClosedAtSettlement: destinations.every((d) => d.closed),
    ingestsAtSettlement: ingest.calls.length, filesAtSettlement: await files(), ownedFilesAtSettlement: accountFiles("upload-fixture"),
    chunksAtSettlement: chunksProduced,
  };
  return result;
});
if (nodeBody) {
  // Undici wraps this live Node iterable, as Next wraps IncomingMessage.
} else if (mode === "missing-boundary") {
  // Leave the source live. Even setup refusal must abandon reception.
} else if (mode === "malformed-header") {
  source.enqueue(Buffer.from("--owned\r\nthis is not a part header\r\n\r\n"));
  end();
} else if (mode === "multiple-files") {
  source.enqueue(Buffer.from(part + contents + "\r\n" + part + contents + ending)); end();
} else if (mode === "wrong-field") {
  source.enqueue(Buffer.from(part.replace('name="file"', 'name="data"') + contents + ending)); end();
} else if (mode === "size-limit") {
  source.enqueue(Buffer.from(part + "x".repeat(2 * 1024 * 1024) + ending)); end();
} else if (mode === "size-limit-at-closing-boundary") {
  // A file of exactly the cap, streamed: the parser reaches the limit and ends
  // the part in one turn, while the part still holds bytes the disk has not taken.
  source.enqueue(Buffer.from(part + "x".repeat(512 * 1024)));
  await firstWriteHeld;
  source.enqueue(Buffer.from("x".repeat(512 * 1024) + ending)); end();
} else {
  source.enqueue(Buffer.from(part + contents));
  if (["success", "delayed-success", "flush-error"].includes(mode)) {
    source.enqueue(Buffer.from(ending)); end();
  } else {
    partialBytes = await partial();
    if (mode === "truncated") end();
    else if (mode === "source-error-then-abort-delayed-close") {
      sourceError();
      await delay(20);
      if (settledSnapshot) throw new Error("fixture settled before the delayed abort");
      controller.abort();
    }
    else if (mode.startsWith("source-error")) sourceError();
    else if (mode === "abort-and-source-error") { sourceError(); controller.abort(); }
    else if (mode.startsWith("abort")) controller.abort();
    else if (mode === "write-error") finishWrite();
  }
}
let timer;
const result = await Promise.race([
  pending,
  new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), 700); }),
]);
clearTimeout(timer);
if (!settledSnapshot) {
  settledSnapshot = { sourceSettled, parserClosedAtSettlement: parsers.every((p) => p.closed), destinationClosedAtSettlement: destinations.every((d) => d.closed),
    ingestsAtSettlement: ingest.calls.length, filesAtSettlement: await files(), ownedFilesAtSettlement: accountFiles("upload-fixture") };
}
await delay(150);
const filesAfterLateWork = await files();
const ownedFilesAfterLateWork = accountFiles("upload-fixture");
const createdBeforeRecovery = destinationsCreated;
recovering = true;
const form = new FormData();
form.append("file", new Blob(["x,y\n1,2\n"]), "recovered.csv");
const recoveryResult = await receive(new Request("http://dezfil.test/api/tables", { method: "POST", body: form }));
const recovery = { status: recoveryResult.status, filename: recoveryResult.filename, bytes: recoveryResult.bytes };
await delay(20);
console.log(JSON.stringify({ timedOut: false, ...result, ...settledSnapshot, partialBytes,
  destinationsCreated: createdBeforeRecovery, filesAfterLateWork, ownedFilesAfterLateWork, globalRejections, secondaryCancellation, recovery,
  chunksProduced, totalChunks }));
// All evidence precedes this fixture cleanup, including late-work observation.
const closures = destinations.map((destination) => new Promise((resolve) => {
  if (destination.closed) resolve();
  else { destination.once("close", resolve); destination.destroy(); }
}));
if (!sourceSettled) {
  if (nodeBody) body.destroy();
  else sourceError();
}
await Promise.all(closures);
await rm(dir, { recursive: true, force: true });
