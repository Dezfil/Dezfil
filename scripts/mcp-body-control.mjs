import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { csvFixture } from './transport-probe-support.mjs';

export const MCP_BODY_LIMIT = 16_777_216;
export const maximumBase64File = envelopeBytes => 3 * Math.floor((MCP_BODY_LIMIT - envelopeBytes) / 4);
/** The stock client supplies its real metadata and request id. First measure
 * its empty-content envelope using a refused non-string content value, then import one byte under the
 * envelope-specific ceiling and independently count every row with SQL. */
export async function mcpBodyControl(base, headers = {}, fetchImpl = fetch) {
  const sent = [];
  const observe = async (input, init) => {
    if (typeof init?.body === 'string') {
      const envelope = JSON.parse(init.body);
      if (envelope.method === 'tools/call' && envelope.params.name === 'upload_table') {
        const wireBytes = Buffer.byteLength(init.body);
        const empty = { ...envelope, params: { ...envelope.params, arguments: { ...envelope.params.arguments, content_base64: '' } } };
        sent.push({ wireBytes, emptyBytes: Buffer.byteLength(JSON.stringify(empty)), metadata: envelope.params._meta ?? null, id: envelope.id });
      }
    }
    return fetchImpl(input, init);
  };
  const client = new Client({ name: 'dezfil-body-control', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/mcp'), { requestInit: { headers }, fetch: observe }));
    const empty = await client.callTool({ name: 'upload_table', arguments: { filename: 'control.csv', content_base64: null } });
    assert.equal(empty.isError, true, 'non-string content must be refused before upload');
    assert.equal(sent.length, 1, 'observe the stock upload envelope');
    const maximumFileBytes = maximumBase64File(sent[0].emptyBytes), bytes = maximumFileBytes - 1;
    const fixture = csvFixture(bytes), file = Buffer.concat([...fixture.chunks()]);
    const uploaded = await client.callTool({ name: 'upload_table', arguments: { filename: 'control.csv', content_base64: file.toString('base64') } });
    const result = uploaded.structuredContent?.result;
    assert.notEqual(uploaded.isError, true, JSON.stringify(uploaded));
    assert.equal(sent[1].emptyBytes, sent[0].emptyBytes, 'client metadata overhead must remain stable for the measured control');
    assert.equal(sent[1].wireBytes, sent[1].emptyBytes + 4 * Math.ceil(bytes / 3));
    assert.ok(sent[1].wireBytes <= MCP_BODY_LIMIT);
    assert.equal(result?.rowCount, fixture.rows, 'MCP upload preserves every row');
    const count = await client.callTool({ name: 'run_sql', arguments: { sql: `SELECT count(*) AS n FROM "${result.name.replaceAll('"', '""')}"` } });
    assert.notEqual(count.isError, true, JSON.stringify(count));
    assert.equal(Number(count.structuredContent?.result?.preview?.[0]?.n), fixture.rows, 'independent SQL count');
    return { emptyEnvelopeBytes: sent[1].emptyBytes, metadata: sent[1].metadata, maximumFileBytes, fileBytes: bytes, wireBytes: sent[1].wireBytes, rows: fixture.rows, table: result.name };
  } finally { await client.close(); }
}
