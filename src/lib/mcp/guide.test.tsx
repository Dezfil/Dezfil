import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpCard } from '@/components/settings/McpCard';
import { settingsDeclarations } from '@/components/settings/settings-index';
import type { Account } from '@/lib/metadata/accounts';
it('the shipped card supplies a client selector, copy and real check entry point', () => {
  const html = renderToStaticMarkup(<McpCard />);
  expect(html).not.toContain('coming soon');
  expect(html).toContain('MCP client');
  expect(html).toContain('Check connection');
  expect(html).toContain('Copy');
});
it('the server-rendered configuration shows the endpoint placeholder before hydration', () => {
  const html = renderToStaticMarkup(<McpCard />);
  expect(html).toMatch(/<pre[^>]*aria-label="Claude Code configuration"[^>]*><code>\/api\/mcp<\/code><\/pre>/);
});
it('points the token step at the card above and links the API reference and the contract, never elsewhere in Settings', () => {
  const html = renderToStaticMarkup(<McpCard />);
  expect(html).toContain('Create a token in the card above.');
  expect(html).not.toMatch(/href="\/settings/);
  expect(html).toContain('href="/developer"');
  expect(html).toContain('href="/api/openapi.json"');
});
it('draws the card and every row the Settings search declares for it, under the declared ids', () => {
  const account = { id: 'ada', name: 'Ada', email: 'ada@example.test', isAdmin: false } as Account;
  const declared = settingsDeclarations({ account, tokens: [], look: null, instance: null, entry: null, health: null, assistant: null, palettes: null }, false)
    .tokens!.find(card => card.id === 'mcp')!;
  expect(declared.rows.map(row => row.id)).toEqual(['set-mcp-client', 'mcp-check']);
  const html = renderToStaticMarkup(<McpCard />);
  for (const id of [declared.id, ...declared.rows.map(row => row.id)]) expect(html).toContain(`id="${id}"`);
});
