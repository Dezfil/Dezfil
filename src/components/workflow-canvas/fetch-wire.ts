/**
 * A fetch the test answers by hand (the coordinator's tests): every
 * request the coordinator makes waits on the wire until the test answers
 * it, accepted, refused or cut, so the interleaving is the test's and
 * never the clock's, and the coordinator under test is the real one
 * rather than a stand-in that hand-writes its semantics. A test double
 * for the browser's fetch and nothing else; no product code imports it.
 */

export interface WireCall {
  method: string;
  headers: Headers;
  path: string;
  /** The JSON body sent, or null. */
  body: unknown;
  /** Whether the test has answered it. */
  answered: boolean;
  /** The server answers 200 with this body. */
  ok: (body: unknown) => void;
  /** Successful headers with an incomplete JSON body. */
  truncated: () => void;
  /** Successful headers followed by a rejected body stream. */
  bodyFailure: () => void;
  /** The server refuses, in the API's error shape. */
  refuse: (status: number, code: string, message: string) => void;
  /** The connection fails: the browser never hears an answer. */
  cut: () => void;
}

export interface Wire {
  fetch: typeof fetch;
  /** Every call made, in the order made, answered or not. */
  calls: WireCall[];
  /** The unanswered calls matching a method and a path, in the order made. */
  pending: (method: string, path: string | RegExp) => WireCall[];
  /** One turn of the loop: everything an answer sets going runs before
   * the next answer is given. */
  settle: () => Promise<void>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function wire(): Wire {
  const calls: WireCall[] = [];
  const fetchLike = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const call: WireCall = {
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        path: typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        answered: false,
        ok: (body) => {
          call.answered = true;
          resolve(json(200, body));
        },
        truncated: () => {
          call.answered = true;
          resolve(new Response('{"step":', { status: 200 }));
        },
        bodyFailure: () => {
          call.answered = true;
          resolve(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Body read failed")); } }), { status: 200 }));
        },
        refuse: (status, code, message) => {
          call.answered = true;
          resolve(json(status, { error: { code, message } }));
        },
        cut: () => {
          call.answered = true;
          reject(new TypeError("Failed to fetch"));
        },
      };
      calls.push(call);
    });
  return {
    fetch: fetchLike as typeof fetch,
    calls,
    pending: (method, path) => calls.filter((c) => !c.answered && c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))),
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}
