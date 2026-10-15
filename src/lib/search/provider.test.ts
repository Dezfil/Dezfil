import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resetLimiter } from "@/lib/geocode/limiter";
import { searchPlaces, geocoderConfigured } from "./provider";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let servers: Server[] = [];

async function stub(handler: Handler): Promise<{
  port: number;
  requests: () => IncomingMessage[];
  connections: () => number;
}> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    handler(req, res);
  });
  let count = 0;
  server.on("connection", () => count++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => seen,
    connections: () => count,
  };
}

const NOMINATIM_ROW = {
  name: "Berlin",
  display_name: "Berlin, Deutschland",
  lat: "52.52",
  lon: "13.405",
  boundingbox: ["52.33", "52.67", "13.08", "13.76"],
  licence: "Data © OpenStreetMap contributors, ODbL 1.0",
};

beforeEach(() => {
  servers = [];
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  // Search now waits for the instance's shared pace, which is process-global
  // and would otherwise carry one test's slot into the next — making a suite
  // about parsing answers spend a second per case on a queue it is not
  // testing.
  resetLimiter();
});

afterEach(async () => {
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_GEOCODER_URL;
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

describe("place search against a Nominatim-shaped stub", () => {
  it("is unconfigured without the setting", async () => {
    expect(geocoderConfigured()).toBe(false);
    expect(await searchPlaces("berlin")).toEqual({ state: "unconfigured" });
  });

  it("speaks /search jsonv2, keeps administrator query params, identifies itself", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([NOMINATIM_ROW]));
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}?key=sekret`;
    const answer = await searchPlaces("berlin");
    expect(answer).toEqual({
      state: "ok",
      attribution: "Data © OpenStreetMap contributors, ODbL 1.0",
      results: [
        {
          name: "Berlin",
          context: "Deutschland",
          lng: 13.405,
          lat: 52.52,
          bounds: [13.08, 52.33, 13.76, 52.67],
        },
      ],
    });
    const req = s.requests()[0];
    const url = new URL(req.url ?? "", "http://x");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("berlin");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("key")).toBe("sekret");
    expect(req.headers["user-agent"]).toContain("Dezfil");
  });

  it("keeps a configured /search path as it is", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200);
      res.end("[]");
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}/search`;
    await searchPlaces("x");
    expect(new URL(s.requests()[0].url ?? "", "http://x").pathname).toBe(
      "/search",
    );
  });

  it("answers an empty result set as ok with no attribution", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200);
      res.end("[]");
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
    expect(await searchPlaces("nowhere")).toEqual({
      state: "ok",
      attribution: null,
      results: [],
    });
  });

  it("treats results without attribution as an invalid answer", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify([{ ...NOMINATIM_ROW, licence: undefined }]));
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
    const answer = await searchPlaces("berlin");
    expect(answer.state).toBe("failed");
  });

  it("resolves failure statuses — a rate limit included — to worded failures", async () => {
    for (const status of [429, 500]) {
      const s = await stub((_req, res) => {
        res.writeHead(status);
        res.end("slow down");
      });
      process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
      const answer = await searchPlaces("berlin");
      expect(answer).toEqual({
        state: "failed",
        message: `The configured geocoding endpoint answered with status ${status}.`,
      });
    }
  });

  it("rejects malformed and oversized bodies without trusting them", async () => {
    const bad = await stub((_req, res) => {
      res.writeHead(200);
      res.end("<html>not json</html>");
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${bad.port}`;
    expect((await searchPlaces("x")).state).toBe("failed");

    const huge = await stub((_req, res) => {
      res.writeHead(200);
      res.end(`["${"a".repeat(1_100_000)}"]`);
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${huge.port}`;
    expect((await searchPlaces("x")).state).toBe("failed");
  });

  it("skips entries without a usable point or name, keeping the rest", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          null, // valid JSON, not an entry — must skip, never throw
          { ...NOMINATIM_ROW, lat: "not-a-number" },
          { ...NOMINATIM_ROW, lat: "" }, // Number("") is 0 — not a point
          { ...NOMINATIM_ROW, lat: "95" }, // out of range
          { ...NOMINATIM_ROW, display_name: "", name: "" },
          NOMINATIM_ROW,
        ]),
      );
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
    const answer = await searchPlaces("berlin");
    expect(answer.state).toBe("ok");
    if (answer.state === "ok") {
      expect(answer.results).toHaveLength(1);
      expect(answer.results[0].lat).toBe(52.52);
    }
  });

  it("drops an out-of-range bounding box but keeps the point", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { ...NOMINATIM_ROW, boundingbox: ["52.33", "95", "13.08", "13.76"] },
        ]),
      );
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
    const answer = await searchPlaces("berlin");
    expect(answer.state).toBe("ok");
    if (answer.state === "ok") {
      expect(answer.results[0].bounds).toBeUndefined();
      expect(answer.results[0].lat).toBe(52.52);
    }
  });

  it("refuses a blocked destination before contact, with the uniform egress message", async () => {
    delete process.env.DEZFIL_EGRESS_ALLOWLIST;
    const s = await stub((_req, res) => res.end("x"));
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
    const answer = await searchPlaces("berlin");
    expect(answer.state).toBe("failed");
    if (answer.state === "failed") {
      expect(answer.message).toContain("not reachable from this server");
    }
    expect(s.connections()).toBe(0);
  });

  /**
   * The claim that matters here is not that the limiter works — its own suite
   * proves that — but that **this caller goes through it at all**. A search
   * issued straight to the wire would leave the deployment-wide pace a
   * promise only the batch keeps, and nothing else would notice.
   */
  it("waits for the instance's shared pace between two searches", async () => {
    const paceMs = 300;
    const schedulerToleranceMs = 50;
    const at: number[] = [];
    const s = await stub((_req, res) => {
      at.push(performance.now());
      res.writeHead(200);
      res.end("[]");
    });
    process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}`;
    process.env.DEZFIL_GEOCODE_PACE_MS = String(paceMs);
    resetLimiter(); // the pace is read when a slot is granted; start clean
    try {
      await searchPlaces("one");
      await searchPlaces("two");
      expect(at).toHaveLength(2);
      // Measured at the server, not at the caller: a client-side wait that
      // never reached the socket would pass a timing check on this side.
      // One full-suite run under concurrent load observed 271 ms against the
 // former 290 ms floor . Keep this a real socket-and-timer
      // measurement, but tolerate scheduler jitter as the limiter suite does.
      expect(at[1] - at[0]).toBeGreaterThanOrEqual(
        paceMs - schedulerToleranceMs,
      );
    } finally {
      delete process.env.DEZFIL_GEOCODE_PACE_MS;
    }
  });

  it("never repeats the configured URL, host, or key in any failure", async () => {
    const cases: (() => Promise<string>)[] = [
      async () => {
        // Unreachable: nothing listens on a fresh port.
        const s = await stub((_req, res) => res.end("x"));
        const port = s.port;
        await new Promise<void>((r) => servers.pop()!.close(() => r()));
        process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${port}?key=sekret`;
        const a = await searchPlaces("x");
        return a.state === "failed" ? a.message : "";
      },
      async () => {
        const s = await stub((_req, res) => {
          res.writeHead(200);
          res.end("not json");
        });
        process.env.DEZFIL_GEOCODER_URL = `http://127.0.0.1:${s.port}?key=sekret`;
        const a = await searchPlaces("x");
        return a.state === "failed" ? a.message : "";
      },
    ];
    for (const run of cases) {
      const message = await run();
      expect(message).not.toBe("");
      expect(message).not.toContain("sekret");
      expect(message).not.toContain("127.0.0.1");
    }
  });
});
