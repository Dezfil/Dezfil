/** Outside proofs require an explicitly isolated instance. Never target the
 * default development listener, even when credentials happen to work. */
export function pictureProofClient(base: string, token: string) {
  const url = new URL(base);
  if (!token || !["http:", "https:"].includes(url.protocol) || url.port === "3000") throw new Error("Picture proofs require an isolated instance on a separate port and a fixture token.");
  async function request(method: string, route: string, body?: unknown, mapId?: string, expectedStatus?: number) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, origin: url.origin };
    if (mapId) headers["X-Edit-Revision"] = (await json<{ editRevision: string }>("GET", `/api/maps/${mapId}`)).editRevision;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(route, url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (expectedStatus === undefined ? !response.ok : response.status !== expectedStatus) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
    return response;
  }
  async function json<T>(method: string, route: string, body?: unknown, mapId?: string): Promise<T> { return (await request(method, route, body, mapId)).json() as Promise<T>; }
  async function picture(mapId: string, expected = "current", previous?: string | null, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const rows = await json<{ id: string; pictureState: string; pictureVersion: string | null; hasThumbnail: boolean }[]>("GET", "/api/maps");
      const row = rows.find(row => row.id === mapId);
      if (row?.pictureState === expected && (previous === undefined || row.pictureVersion !== previous)) return row;
      if (row?.pictureState === "unavailable") throw new Error("The fixture instance has no renderer.");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Picture ${mapId} did not reach ${expected}.`);
  }
  return { request, json, picture };
}
