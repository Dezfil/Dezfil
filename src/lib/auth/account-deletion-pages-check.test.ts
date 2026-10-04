import { expect, it } from "vitest";
import { assertDeletionPage } from "../../../scripts/deletion-journey-pages.mjs";

const page = { route: "/maps/target", refused: false, targetName: "Target content sentinel" };
const shell = "<html><title>Dezfil</title><body>Application shell</body></html>";

it.each(["/maps/target", "/maps/control", "/v/target", "/v/target?embed=1", "/v/control"])("accepts the warm or independent server shell at %s", route => {
  expect(() => assertDeletionPage({ status: 200, body: shell }, { ...page, route })).not.toThrow();
});
it.each([302, 403, 404, 500])("rejects a %i warm or independent page", status => {
  expect(() => assertDeletionPage({ status, body: shell }, page)).toThrow();
});
it("rejects a streamed not-found boundary as a positive control", () => {
  expect(() => assertDeletionPage({ status: 200, body: "NEXT_HTTP_ERROR_FALLBACK;404" }, page)).toThrow();
});
it("detects a cached-admission defect returning the shell after acceptance", () => {
  expect(() => assertDeletionPage({ status: 200, body: shell }, { ...page, refused: true })).toThrow("accepted owner must be absent");
});
it.each([404, 200])("accepts a %i refusal with no target material", status => {
  const body = status === 404 ? shell : "NEXT_HTTP_ERROR_FALLBACK;404";
  expect(() => assertDeletionPage({ status, body }, { ...page, refused: true })).not.toThrow();
  expect(() => assertDeletionPage({ status, body: body + page.targetName }, { ...page, refused: true })).toThrow("no target material");
});
