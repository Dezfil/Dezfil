import assert from 'node:assert/strict';

export function assertDeletionPage({ status, body }, { route, refused, targetName }) {
  const notFound = status === 404 || body.includes('NEXT_HTTP_ERROR_FALLBACK;404');
  if (refused) {
    // Next can stream the not-found boundary with HTTP 200 after headers.
    assert.ok(notFound, `accepted owner must be absent from built page ${route}`);
    assert.ok(!body.includes(targetName), 'refused page contains no target material');
  } else {
    // Workspace content is client-rendered; the server returns the app shell.
    assert.equal(status, 200, `warm or independent page ${route}`);
    assert.ok(!notFound, `warm or independent page must not render not-found: ${route}`);
  }
}
