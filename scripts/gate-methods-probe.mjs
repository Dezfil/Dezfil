import assert from 'node:assert/strict';

/** Contract expectations come from the served description, never the gate table. */
export async function probeGateMethods(base, token, document) {
  const headers = { authorization: `Bearer ${token}` };
  let checks = 0;
  for (const [path, methods] of Object.entries(document.paths)) {
    const allowed = Object.keys(methods).map(method => method.toUpperCase()).sort();
    const concrete = path.replaceAll(/\{[^}]+\}/g, 'fixture');
    const method = ['PUT', 'PATCH', 'DELETE', 'POST', 'GET'].find(value => !allowed.includes(value));
    const refusal = await fetch(base + concrete, { method, headers });
    assert.equal(refusal.status, 405, `${method} ${path}`);
    assert.deepEqual(await refusal.json(), { error: { code: 'method_not_allowed', message: 'This method is not allowed for this path.' } });
    assert.deepEqual(refusal.headers.get('allow')?.split(', ').sort(), allowed, path);
    const options = await fetch(base + concrete, { method: 'OPTIONS', headers });
    assert.equal(options.status, 204); assert.equal(await options.text(), '');
    assert.deepEqual(options.headers.get('allow')?.split(', ').sort(), allowed, path);
    if (allowed.includes('HEAD')) {
      const head = await fetch(base + concrete, { method: 'HEAD', headers });
      assert.notEqual(head.status, 405, path); assert.equal(await head.text(), '');
    }
    checks++;
  }
  const unknown = await fetch(base + '/api/not-a-documented-route', { method: 'PUT', headers });
  assert.equal(unknown.status, 404); await unknown.body?.cancel();
  return checks;
}
