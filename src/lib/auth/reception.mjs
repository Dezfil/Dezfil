import { AsyncLocalStorage } from "node:async_hooks";

export const ORDINARY_RECEIVE_MS = 300_000;
export const UPLOAD_STALL_MS = 60_000;
export const REFUSAL_DELIVERY_MS = 5_000;
// Stored processing limits end at six hours. A larger deployment override
// raises this outer clock when the upload is admitted, before it can expire.
export const SERVER_RECEIVE_MS = 21_720_000;
const contextKey = Symbol.for("dezfil.native-reception-context");
const context = process[contextKey] ??= new AsyncLocalStorage();
export const withNativeReception = (owner, work) => context.run(owner, work);
const refusal = (code, message, status = 408) => Object.assign(new Error(message), { code, status });

export function createUploadClock(budgetMs, remedy, onRefusal) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError("A reception budget must be positive and finite.");
  const deadline = performance.now() + budgetMs;
  let timer, stall, failure, complete = false;
  const clear = () => { clearTimeout(timer); clearTimeout(stall); };
  const refuse = error => {
    if (failure || complete) return;
    failure = error; clear(); onRefusal(error);
  };
  const arm = () => {
    timer = setTimeout(() => {
      if (performance.now() < deadline) arm();
      else refuse(refusal("data_processing_timeout", `Upload exceeded the ${budgetMs / 1000} s reception time limit. ${remedy}`));
    }, Math.min(2_147_483_647, Math.max(0, deadline - performance.now())));
    timer.unref?.();
  };
  const progress = () => {
    if (failure || complete) return;
    clearTimeout(stall);
    stall = setTimeout(() => refuse(refusal("upload_stalled", "The upload sent no body bytes for 60 s. Retry the upload.")), UPLOAD_STALL_MS);
    stall.unref?.();
  };
  arm(); progress();
  return { refuse, progress, endBody() { clearTimeout(stall); }, complete() { complete = true; clear(); }, get failure() { return failure; } };
}

/** Returning a native async generator queues behind its pending next(). This
 * iterator settles that pending read itself without destroying the socket that
 * must carry the refusal. It never drains an unread tail. */
export function receptionIterator(request, stops) {
  let stopped = false, waiting, failure;
  const detach = () => {
    request.removeListener("readable", wake); request.removeListener("end", wake);
    request.removeListener("error", error); request.removeListener("close", closed);
    stops.delete(stop);
  };
  const finish = reason => {
    if (stopped) return;
    stopped = true; failure = reason; detach();
    if (reason) waiting?.reject(reason);
    else waiting?.resolve({ done: true, value: undefined });
    waiting = undefined;
  };
  const stop = () => finish(new DOMException("Body reception stopped.", "AbortError"));
  const error = reason => finish(reason);
  const wake = () => {
    if (!waiting || stopped) return;
    const chunk = request.read();
    if (chunk !== null) { const pending = waiting; waiting = undefined; pending.resolve({ done: false, value: chunk }); }
    else if (request.readableEnded || request.complete) finish();
    else if (request.destroyed) stop();
  };
  request.on("readable", wake); request.on("end", wake);
  const closed = () => request.readableEnded ? finish() : stop();
  request.on("error", error); request.on("close", closed); stops.add(stop);
  return {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (stopped) return failure ? Promise.reject(failure) : Promise.resolve({ done: true, value: undefined });
      if (waiting) return Promise.reject(new Error("Concurrent native body reads are not supported."));
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; wake(); });
    },
    return() { stop(); return Promise.resolve({ done: true, value: undefined }); },
  };
}

export function nativeUploadReception(budgetMs, remedy, onRefusal) {
  return context.getStore()?.admit(budgetMs, remedy, onRefusal);
}

/** Own reception on the native request, before any framework body copy. */
export function installReception(server, request, response, upload) {
  if (!response?.once || typeof request.push !== "function") return undefined;
  const stops = new Set();
  let clock, failure, listener, delivery, closing, answered = false, received = false;
  const socket = request.socket;
  const hasBody = !!request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0;
  const bodyComplete = () => request.complete || !hasBody;
  const ordinary = setTimeout(() => decide(refusal("request_timeout", "The request body was not received within 300 s.")), ORDINARY_RECEIVE_MS);
  ordinary.unref?.();
  const stopReaders = () => { for (const stop of stops) stop(); };
  const clear = () => { clearTimeout(ordinary); clock?.complete(); clearTimeout(delivery); };
  const closeConnection = () => {
    // Gracefully finish the outgoing side after the JSON has been written.
    // A peer that will not read or finish its body cannot keep the socket alive.
    socket.end();
    closing ??= setTimeout(() => socket.destroy(), REFUSAL_DELIVERY_MS);
    closing.unref?.();
  };
  const original = Object.fromEntries(["writeHead", "setHeader", "appendHeader", "removeHeader", "flushHeaders", "write", "end"].map(name => [name, response[name].bind(response)]));
  for (const name of Object.keys(original)) {
    response[name] = function (...args) {
      if (answered) {
        const callback = args.at(-1); if (typeof callback === "function") queueMicrotask(callback);
        return name === "write" ? true : this;
      }
      if (name === "writeHead" && !bodyComplete()) {
        original.setHeader("connection", "close");
        // Node normally destroys an early-close socket as soon as its writes
        // flush. Keep its readable half alive for bounded refusal delivery.
        socket.destroySoon = closeConnection;
      }
      return original[name](...args);
    };
  }
  const deliver = () => {
    if (response.writableEnded || response.destroyed || failure?.status === 499) return;
    if (response.headersSent) { closeConnection(); return; }
    const body = JSON.stringify({ error: { code: failure.code, message: failure.message } });
    socket.destroySoon = closeConnection;
    original.writeHead(failure.status, { "content-type": "application/json", "cache-control": "private, no-store", "content-length": Buffer.byteLength(body), connection: "close" });
    answered = true;
    original.end(body);
    closeConnection();
  };
  function decide(error) {
    if (failure || received) return;
    failure = error; clearTimeout(ordinary); clock?.refuse(error);
    if (!listener && error.status !== 499) deliver();
    listener?.(error); stopReaders();
    if (error.status === 499) return;
    // Normally the app settles its file and sends the same refusal first.
    // A delayed filesystem cancellation cannot delay the wire indefinitely.
    delivery ??= setTimeout(deliver, 1_000);
    delivery.unref?.();
    closing ??= setTimeout(() => socket.destroy(), REFUSAL_DELIVERY_MS);
    closing.unref?.();
  }
  const push = request.push;
  request.push = function (chunk, ...args) {
    if (chunk === null) { clearTimeout(ordinary); clock?.endBody(); }
    else if (chunk.length) clock?.progress();
    return push.call(this, chunk, ...args);
  };
  request[Symbol.asyncIterator] = function () { return receptionIterator(this, stops); };
  const abort = () => decide(refusal(null, "The caller left.", 499));
  request.once("aborted", abort);
  // The owner observes native cancellation even when no iterator was opened.
  request.on("error", error => {
    if (request.aborted || error.code === "ECONNRESET") abort();
    else decide(refusal("invalid_request", "The request body was interrupted.", 400));
  });
  response.once("finish", () => {
    clear(); stopReaders();
    if (!bodyComplete()) closeConnection();
  });
  response.once("close", () => { if (!response.writableFinished && !received) abort(); clear(); stopReaders();  });
  const closed = () => { clearTimeout(closing); };
  socket.once("close", closed);
  response.once("finish", () => { if (bodyComplete() && !failure) socket.removeListener("close", closed); });
  return {
    admit(budgetMs, remedy, onRefusal) {
      if (!upload) return undefined;
      if (clock) throw new Error("Upload reception has already been admitted.");
      listener = onRefusal; clearTimeout(ordinary);
      server.requestTimeout = Math.max(server.requestTimeout, budgetMs + 120_000);
      clock = createUploadClock(budgetMs, remedy, decide);
      if (request.complete) clock.endBody();
      if (failure) { clock.refuse(failure); listener(failure); }
      return {
        refuse: decide,
        progress() {}, // Native pushes count arriving bytes, including buffered bytes.
        endBody() { clock.endBody(); },
        complete() { received = true; clear(); listener = undefined; },
        get failure() { return failure; },
      };
    },
  };
}
