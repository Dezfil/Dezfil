import { describe, expect, it } from "vitest";
import {
  ANSWER_CURRENT,
  NETWORK_FAILURE,
  beginAnswer,
  failureProse,
  resolveAnswer,
  settleVerdict,
} from "./dashboard-state";
import type { LayerRenderData } from "@/lib/layer-service";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

// The dashboard truth states: the pure half of the state machine found
// missing. One regression per failure class, plus the superseded rule
// and the loading/updating split.

describe("failureProse", () => {
  it("gives published readers request-only rate-limit wording while retaining sign-in detail for authors", () => {
    const failure = { code: "rate_limited", message: ERROR_CATALOGUE.rate_limited };
    expect(failureProse(failure, "reader")).toBe("Too many requests. Retry after the indicated delay.");
    expect(failureProse(failure, "author")).toBe("Too many requests or sign-in attempts; retry after the indicated delay.");
  });
});

describe("beginAnswer", () => {
  it("loads when nothing was ever computed — never a computed empty answer", () => {
    expect(beginAnswer(false)).toEqual({ status: "loading", error: null });
  });

  it("updates over a prior answer — shown only as being replaced", () => {
    expect(beginAnswer(true)).toEqual({ status: "updating", error: null });
  });
});

describe("resolveAnswer", () => {
  it("a successful outcome becomes current", () => {
    expect(
      resolveAnswer(beginAnswer(true), false, { ok: true, data: {} }),
    ).toEqual(ANSWER_CURRENT);
  });

  it("an HTTP refusal becomes failed with the documented code", () => {
    const refused = {
      ok: false as const,
      error: { code: "rate_limited", message: "Too many requests." },
    };
    expect(resolveAnswer(beginAnswer(true), false, refused)).toEqual({
      status: "failed",
      error: refused.error,
    });
  });

  it("a transport failure becomes failed with the client-local code", () => {
    const state = resolveAnswer(beginAnswer(false), false, {
      ok: false,
      error: NETWORK_FAILURE,
    });
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("network");
  });

  it("a superseded outcome is not a failure — the newer fetch owns the state", () => {
    const updating = beginAnswer(true);
    const afterLateFailure = resolveAnswer(updating, true, {
      ok: false,
      error: NETWORK_FAILURE,
    });
    expect(afterLateFailure).toEqual(updating);
    const afterLateSuccess = resolveAnswer(updating, true, {
      ok: true,
      data: {},
    });
    expect(afterLateSuccess).toEqual(updating);
  });
});

describe("settleVerdict", () => {
  const settled: LayerRenderData = {
    layerId: "l1",
    ok: true,
    geojson: { type: "FeatureCollection", features: [] },
  };

  it("a usable render is the answer", () => {
    const v = settleVerdict({ ok: true, data: settled });
    expect(v.render).toBe(settled);
    expect(v.failure).toBeNull();
  });

  it("an errored envelope fails with the server's coded reason", () => {
    const v = settleVerdict({
      ok: true,
      data: {
        layerId: "l1",
        ok: false,
        error: { code: "query_timeout", message: "The query timed out." },
      },
    });
    expect(v.render).toBeNull();
    expect(v.failure).toEqual({
      code: "query_timeout",
      message: "The query timed out.",
    });
  });

  it("an envelope without a reason still fails coded, never silently", () => {
    const v = settleVerdict({ ok: true, data: { layerId: "l1", ok: false } });
    expect(v.render).toBeNull();
    expect(v.failure?.code).toBe("internal");
  });

  it("an HTTP refusal carries its documented code through", () => {
    const v = settleVerdict({
      ok: false,
      error: { code: "field_not_published", message: "Not published." },
    });
    expect(v.render).toBeNull();
    expect(v.failure?.code).toBe("field_not_published");
  });

  it("a transport failure carries the client-local code", () => {
    const v = settleVerdict({ ok: false, error: NETWORK_FAILURE });
    expect(v.failure?.code).toBe("network");
  });
});
