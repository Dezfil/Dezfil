import { createServer, isIP, Socket } from "node:net";
import { admitRenderHost, type RenderResolver } from "./render-address";
import { SocksHandshake, SocksProtocolError, socksReply, type SocksTarget } from "./render-socks";

export interface RenderRelay {
  readonly port: number;
  readonly refused: boolean;
  /** Pending policy decisions also count if the page abandoned their request. */
  settleAdmissions(): Promise<void>;
  /** Destroy all current sockets, but remember only the supplied stalled
   * hosts for re-dial refusal in this render. Other hosts and the listener
   * remain available. IPv6 spellings share one canonical host key. */
  abandon(hosts: readonly string[]): void;
  /** Synchronously revokes dialing and destroys every owned socket. */
  close(): void;
}

export interface RenderRelayOptions {
  deadline: number;
  requestBoundMs: number;
  signal?: AbortSignal;
  /** Resolver seam; connections always use real TCP sockets. */
  resolve?: RenderResolver;
}

/** One unauthenticated loopback listener per render. Local clients have exactly
 * the same destination policy; this grants no local-client exclusivity. */
export async function startRenderRelay(options: RenderRelayOptions): Promise<RenderRelay> {
  const sockets = new Set<Socket>();
  // Match names case-insensitively and IPv6 literals across URL and SOCKS
  // spellings. A fresh render starts with no abandoned hosts.
  const abandonedHosts = new Set<string>();
  const admissions = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let refused = false;
  const timer = (fn: () => void, ms: number) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, Math.max(1, ms));
    timers.add(id);
    return id;
  };
  const untimer = (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); timers.delete(id); };
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const server = createServer((incoming) => {
    const client = own(incoming);
    if (closed) { client.destroy(); return; }
    const parser = new SocksHandshake();
    const connectDeadline = Math.min(options.deadline, Date.now() + options.requestBoundMs);
    const pendingTimer = timer(() => client.destroy(), connectDeadline - Date.now());
    client.once("close", () => untimer(pendingTimer));
    const fail = (code: number) => {
      if (!client.destroyed) client.end(socksReply(code));
      // A peer need not finish its half of the close to release our resources.
    };
    const connect = async ({ host, port }: SocksTarget, rest: Buffer) => {
      if (abandonedHosts.has(relayHostKey(host))) {
        // Host unreachable, not an egress-policy denial. Fail retries before
        // admission or dialing, including retries invisible to page events.
        fail(4);
        return;
      }
      const admission = await admitRenderHost(host, options.resolve);
      if (closed) return;
      if (admission.verdict !== "allow") {
        if (admission.verdict === "deny") refused = true;
        fail(admission.verdict === "deny" ? 2 : 4);
        return;
      }
      for (let index = 0; index < admission.addresses.length; index++) {
        if (closed || client.destroyed || Date.now() >= connectDeadline) return;
        const upstream = own(new Socket());
        const destroyUpstream = () => upstream.destroy();
        client.once("close", destroyUpstream);
        const connected = await new Promise<boolean>((resolve) => {
          const remaining = connectDeadline - Date.now();
          // A blackholed first address must not consume the entire request.
          const attempt = timer(() => upstream.destroy(), index + 1 < admission.addresses.length ? Math.min(250, remaining) : remaining);
          const finish = (ok: boolean) => {
            untimer(attempt);
            upstream.off("connect", onConnect);
            upstream.off("close", onClose);
            resolve(ok);
          };
          const onConnect = () => finish(true);
          const onClose = () => finish(false);
          upstream.once("connect", onConnect);
          upstream.once("close", onClose);
          // No name is ever handed to net.connect, including on fallback.
          upstream.connect({ host: admission.addresses[index], port });
        });
        if (!connected) {
          client.off("close", destroyUpstream);
          continue;
        }
        if (closed || client.destroyed) { upstream.destroy(); return; }
        untimer(pendingTimer);
        upstream.once("close", () => client.destroy());
        client.write(socksReply(0));
        // Both pipes supply stream backpressure. A coalesced first payload is
        // written before resuming the client's readable side.
        upstream.pipe(client);
        if (rest.length && !upstream.write(rest)) await new Promise<void>((resolve) => {
          const done = () => { upstream.off("drain", done); upstream.off("close", done); resolve(); };
          upstream.once("drain", done); upstream.once("close", done);
        });
        if (!upstream.destroyed) client.pipe(upstream);
        return;
      }
      fail(4);
    };
    const onData = (chunk: Buffer) => {
      try {
        const result = parser.push(chunk);
        for (const reply of result.replies) client.write(reply);
        if (!result.target) return;
        client.pause();
        client.off("data", onData);
        const connecting = connect(result.target, result.rest!);
        admissions.add(connecting);
        void connecting.catch(() => client.destroy()).finally(() => admissions.delete(connecting));
      } catch (error) {
        client.off("data", onData);
        if (error instanceof SocksProtocolError && error.reply) client.end(error.reply);
        else client.destroy();
      }
    };
    client.on("data", onData);
  });
  const abandon = (hosts: readonly string[]) => {
    for (const host of hosts) abandonedHosts.add(relayHostKey(host));
    for (const socket of sockets) socket.destroy();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", close);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    server.close();
    abandon([]);
  };
  server.on("error", close);
  timer(close, options.deadline - Date.now());
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    if (options.signal?.aborted || Date.now() >= options.deadline) throw Error("Render relay expired");
    await new Promise<void>((resolve, reject) => {
      const onClose = () => reject(Error("Render relay closed during startup"));
      server.once("close", onClose);
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("close", onClose); server.off("error", reject);
        if (closed) { server.close(); reject(Error("Render relay expired")); }
        else resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Render relay has no address");
    return {
      port: address.port, get refused() { return refused; }, close, abandon,
      async settleAdmissions() {
        while (!closed && admissions.size) await Promise.allSettled([...admissions]);
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

function relayHostKey(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  // URL syntax rejects zone identifiers accepted by isIP. Strip the zone
  // only for this key; admission still receives the original address.
  return isIP(bare) === 6 ? new URL(`http://[${bare.split("%", 1)[0]}]/`).hostname.slice(1, -1) : bare.toLowerCase();
}
