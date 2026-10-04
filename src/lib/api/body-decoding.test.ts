import { expect, it } from "vitest";
import { smallJsonValue, largeJsonValue, largeBodyText } from "./json-body";
import { authBody } from "@/lib/auth/http";
import { jsonBody } from "@/lib/operations/recipe-api";
import { publishedJsonBody } from "@/lib/publish/published-body";
const request = (body: Uint8Array) => new Request("http://instance.test", { method: "POST", headers: { "content-type": "application/json" }, body: body as BodyInit });
const invalidUtf8 = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([255]), Buffer.from('"}')]);
it.each([smallJsonValue, largeJsonValue])("preserves Request.json replacement decoding for an admitted body", async read => {
  const expected = await request(invalidUtf8).json();
  await expect(read(request(invalidUtf8))).resolves.toEqual(expected);
});
it("preserves Request.text replacement decoding for optional general bodies", async () => {
  await expect(largeBodyText(request(invalidUtf8))).resolves.toBe(await request(invalidUtf8).text());
});
it("keeps malformed UTF-8 JSON on the authentication validation path", async () => {
  await expect(authBody(request(Buffer.from([255])), ["name"])).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  await expect(authBody(request(invalidUtf8), ["name"])).resolves.toEqual({ name: "�" });
});
it("retains the existing strict workflow and published decoders", async () => {
  for (const read of [jsonBody, publishedJsonBody]) await expect(read(request(invalidUtf8))).rejects.toMatchObject({ status: 400, code: "invalid_request" });
});
