import assert from 'node:assert/strict';

/** Keep the closing JSON delimiters at the end: a framework-truncated body
 * must fail parsing instead of silently losing harmless trailing whitespace. */
export function sizedJson(value, bytes, encoding) {
  const empty = JSON.stringify({ ...value, _padding: '' });
  const left = bytes - Buffer.byteLength(empty), unit = encoding === 'escaped' ? '\\u96ea' : '雪';
  assert.ok(left >= 0);
  const width = Buffer.byteLength(unit), body = empty.slice(0, -2) + unit.repeat(Math.floor(left / width)) + ' '.repeat(left % width) + '"}';
  assert.equal(Buffer.byteLength(body), bytes);
  return Buffer.from(body);
}
export function assertByteRefusal(result, limit, { code = 'request_body_too_large', workflow = false, message } = {}) {
  assert.equal(result.status, 413, `expected byte refusal, received ${result.status}: ${result.text ?? JSON.stringify(result.json)}`);
  assert.deepEqual(result.json, { error: { code, message: message ?? `The ${workflow ? 'workflow request' : 'request'} body exceeds the ${limit}-byte limit.` } });
}
export function assertValidation(result, expected) {
  assert.equal(result.status, expected.status, `boundary did not reach validation: ${result.text ?? JSON.stringify(result.json)}`);
  assert.deepEqual(result.json, expected.json, 'boundary must reach the same semantic validation as its small control');
}
export function assertNoBodyMutation(before, after) { assert.deepEqual(after, before, 'body refusal or validation mutated resources'); }
export function chunksOf(body) { return (function* () { for (let at = 0; at < body.length; at += 65_536) yield body.subarray(at, at + 65_536); })(); }
