import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CATALOGUE_FORMAT_VERSION,
  CATALOGUE_INDEX_FILE,
  TEMPLATE_THEMES,
  type CatalogueEntry,
  type CatalogueIndex,
} from "../../src/lib/templates/format";
import type { BuiltTemplate } from "./builder";

/**
 * Catalogue fixtures, both on this machine.
 *
 * The loopback catalogue serves an index, archives and pictures from two
 * servers: the catalogue's own origin (`http://localhost:<port>`) and a
 * second host (`http://127.0.0.1:<port>`), standing where a release's files
 * are served from after a redirect. Every request either receives is
 * recorded with its headers. A path can answer bytes, a redirect (to the
 * same host, the second host, or anywhere), a status, a stall that never
 * answers, or a response held until the test releases it. A test sets the
 * egress allowlist to both hosts (`localhost,127.0.0.1`), as an admin would
 * for a catalogue on a private network; nothing is reached elsewhere.
 *
 * The folder fixture is a catalogue on disk: the index and the archives
 * and pictures it names, as files, the addresses relative to the index.
 */

export type Host = "primary" | "second";

export interface RecordedRequest {
  host: Host;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

type Route =
  | { kind: "body"; status: number; type: string; body: Buffer }
  | { kind: "redirect"; status: number; to: string }
  | { kind: "stall" }
  | { kind: "held"; body: Buffer; type: string; arrived: () => void; released: Promise<void> };

export interface HeldResponse {
  /** Settles when a request for the path has arrived and is being held. */
  arrived: Promise<void>;
  /** Let the held response go. */
  release(): void;
}

export interface PublishOptions {
  /** Serve each archive from the second host behind a redirect from the
   * catalogue's origin, as a release's download is served. */
  releaseStyle?: boolean;
  /** Write the archive addresses as absolute addresses on the origin. */
  absolute?: boolean;
  /** Change the index before it is served. */
  edit?: (index: CatalogueIndex) => void;
}

export interface LoopbackCatalogue {
  /** The catalogue's origin, `http://localhost:<port>`. */
  origin: string;
  /** The second host's origin, `http://127.0.0.1:<port>`. */
  secondOrigin: string;
  /** The catalogue address: the index on the origin. */
  indexUrl: string;
  /** Every request either host received, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  /** The requests for one path on one host. */
  requestsFor(path: string, host?: Host): RecordedRequest[];
  serve(path: string, body: Buffer | string, options?: { host?: Host; type?: string; status?: number }): void;
  redirect(path: string, to: string, options?: { host?: Host; status?: number }): void;
  status(path: string, status: number, options?: { host?: Host }): void;
  stall(path: string, options?: { host?: Host }): void;
  hold(path: string, body: Buffer | string, options?: { host?: Host; type?: string }): HeldResponse;
  /** Serve an index listing these templates, with their archives and
   * pictures; answers the index as served. */
  publish(templates: readonly BuiltTemplate[], options?: PublishOptions): Promise<CatalogueIndex>;
  close(): Promise<void>;
}

function listen(server: Server, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

const archiveName = (t: BuiltTemplate) => `${t.facts.id}-${t.facts.version}.zip`;
const pictureName = (t: BuiltTemplate, theme: string) => `${t.facts.id}-${t.facts.version}-${theme}.png`;

/** The entry an index gives a built template, its addresses as given. */
export function catalogueEntry(
  template: BuiltTemplate,
  addresses: { archive: string; pictures: Record<(typeof TEMPLATE_THEMES)[number], string> },
): CatalogueEntry {
  return {
    facts: template.facts,
    size: template.size,
    sha256: template.sha256,
    archive: addresses.archive,
    pictures: addresses.pictures,
  };
}

export async function startLoopbackCatalogue(): Promise<LoopbackCatalogue> {
  const routes: Record<Host, Map<string, Route>> = { primary: new Map(), second: new Map() };
  const requests: RecordedRequest[] = [];
  const pending = new Set<ServerResponse>();

  const handler = (host: Host) => (req: import("node:http").IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    requests.push({ host, method: req.method ?? "GET", path: url.pathname, headers: { ...req.headers } });
    const route = routes[host].get(url.pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    switch (route.kind) {
      case "body":
        res.writeHead(route.status, { "content-type": route.type, "content-length": String(route.body.length) });
        res.end(route.body);
        return;
      case "redirect":
        res.writeHead(route.status, { location: route.to });
        res.end();
        return;
      case "stall":
        pending.add(res);
        return;
      case "held":
        pending.add(res);
        route.arrived();
        void route.released.then(() => {
          pending.delete(res);
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": route.type, "content-length": String(route.body.length) });
          res.end(route.body);
        });
        return;
    }
  };

  const primary = createServer(handler("primary"));
  const second = createServer(handler("second"));
  // The origin answers on every loopback family, so `localhost` reaches it
  // whichever address it resolves to; the second host is one literal.
  const primaryPort = await listen(primary);
  const secondPort = await listen(second, "127.0.0.1");
  const origin = `http://localhost:${primaryPort}`;
  const secondOrigin = `http://127.0.0.1:${secondPort}`;
  const indexPath = `/${CATALOGUE_INDEX_FILE}`;

  const set = (path: string, route: Route, host: Host = "primary") => { routes[host].set(path, route); };

  const catalogue: LoopbackCatalogue = {
    origin,
    secondOrigin,
    indexUrl: `${origin}${indexPath}`,
    requests,
    requestsFor: (p, host) => requests.filter((r) => r.path === p && (host === undefined || r.host === host)),
    serve(p, body, options = {}) {
      set(p, {
        kind: "body",
        status: options.status ?? 200,
        type: options.type ?? "application/octet-stream",
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      }, options.host);
    },
    redirect(p, to, options = {}) { set(p, { kind: "redirect", status: options.status ?? 302, to }, options.host); },
    status(p, status, options = {}) {
      set(p, { kind: "body", status, type: "text/plain", body: Buffer.from(`status ${status}`) }, options.host);
    },
    stall(p, options = {}) { set(p, { kind: "stall" }, options.host); },
    hold(p, body, options = {}) {
      let arrived!: () => void;
      let release!: () => void;
      const arrival = new Promise<void>((resolve) => { arrived = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      set(p, {
        kind: "held",
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
        type: options.type ?? "application/octet-stream",
        arrived,
        released,
      }, options.host);
      return { arrived: arrival, release };
    },
    async publish(templates, options = {}) {
      const entries: CatalogueEntry[] = [];
      for (const t of templates) {
        const archive = await readFile(t.archive);
        const name = archiveName(t);
        const archivePath = `/archives/${name}`;
        if (options.releaseStyle) {
          catalogue.serve(`/assets/${name}`, archive, { host: "second" });
          catalogue.redirect(archivePath, `${secondOrigin}/assets/${name}`);
        } else {
          catalogue.serve(archivePath, archive);
        }
        const pictures = {} as Record<(typeof TEMPLATE_THEMES)[number], string>;
        for (const theme of TEMPLATE_THEMES) {
          const picturePath = `/pictures/${pictureName(t, theme)}`;
          const bytes = t.files.binaries.get(t.facts.pictures[theme]);
          if (bytes) catalogue.serve(picturePath, bytes, { type: "image/png" });
          pictures[theme] = options.absolute ? `${origin}${picturePath}` : picturePath.slice(1);
        }
        entries.push(catalogueEntry(t, {
          archive: options.absolute ? `${origin}${archivePath}` : archivePath.slice(1),
          pictures,
        }));
      }
      const index: CatalogueIndex = { formatVersion: CATALOGUE_FORMAT_VERSION, templates: entries };
      options.edit?.(index);
      catalogue.serve(indexPath, JSON.stringify(index), { type: "application/json" });
      return index;
    },
    async close() {
      for (const res of pending) res.destroy();
      pending.clear();
      await Promise.all([primary, second].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })));
    },
  };
  return catalogue;
}

/**
 * Write a catalogue on disk under `dir`: the index, and the archives and
 * pictures it names, at addresses relative to the index. Answers the index
 * as written.
 */
export async function writeFolderCatalogue(
  dir: string,
  templates: readonly BuiltTemplate[],
  options: { edit?: (index: CatalogueIndex) => void } = {},
): Promise<CatalogueIndex> {
  await mkdir(path.join(dir, "archives"), { recursive: true });
  await mkdir(path.join(dir, "pictures"), { recursive: true });
  const entries: CatalogueEntry[] = [];
  for (const t of templates) {
    const archive = `archives/${archiveName(t)}`;
    await copyFile(t.archive, path.join(dir, archive));
    const pictures = {} as Record<(typeof TEMPLATE_THEMES)[number], string>;
    for (const theme of TEMPLATE_THEMES) {
      const picture = `pictures/${pictureName(t, theme)}`;
      const bytes = t.files.binaries.get(t.facts.pictures[theme]);
      if (bytes) await writeFile(path.join(dir, picture), bytes);
      pictures[theme] = picture;
    }
    entries.push(catalogueEntry(t, { archive, pictures }));
  }
  const index: CatalogueIndex = { formatVersion: CATALOGUE_FORMAT_VERSION, templates: entries };
  options.edit?.(index);
  await writeFile(path.join(dir, CATALOGUE_INDEX_FILE), JSON.stringify(index, null, 2) + "\n");
  return index;
}
