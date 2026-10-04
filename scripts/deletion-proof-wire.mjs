import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { journeyApi } from './journey-http.mjs';

export async function deletionProofWire(port) {
  const replies = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    for await (const chunk of request) void chunk;
    const next = replies.shift(); if (!next) { response.writeHead(500).end('No scripted reply'); return; }
    const output = next.call ? [{ type: 'function_call', id: randomUUID(), call_id: randomUUID(), name: next.call.name, arguments: JSON.stringify(next.call.args), status: 'completed' }]
      : [{ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: randomUUID(), model: 'scripted-model', status: 'completed', output } })}\n\n`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port,
    async call(base, credential, name, args, { mutation = false, approved = true, beforeResolution = async () => {} } = {}) {
      assert.equal(replies.length, 0); replies.push({ call: { name, args } }, {});
      const api = journeyApi(base, credential);
      try {
        const reserved = await api('POST', '/api/assistant/runs'); assert.equal(reserved.status, 201);
        const stream = async body => {
          const response = await api('POST', '/api/assistant/messages', { body, raw: true }); assert.equal(response.status, 200);
          return (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        };
        let events = await stream({ runId: reserved.json.id, message: `Perform ${name}.`, history: [] });
        if (mutation) {
          const pending = events.find(event => event.type === 'confirm_required' && event.tool === name);
          assert.ok(pending, `assistant must confirm ${name}: ${JSON.stringify(events)}`);
          assert.match(pending.confirmation.consequence, /permanently/); assert.match(pending.confirmation.consequence, /links/);
          assert.equal(events.some(event => event.type === 'tool_result' && event.tool === name && event.ok), false);
          await beforeResolution(pending);
          events = await stream({ resolution: { pending: pending.id, approved } });
        }
        const result = events.find(event => event.type === 'tool_result' && event.tool === name);
        assert.ok(result, `${name} result: ${JSON.stringify(events)}`);
        if (mutation) assert.equal(result.decision, approved ? 'approved' : 'declined');
        return result;
      } finally { replies.length = 0; }
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
