import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpSection } from '@/components/McpSection';
it('the shipped card supplies a client selector, copy and real check entry point', () => {
  const html = renderToStaticMarkup(<McpSection />);
  expect(html).not.toContain('coming soon');
  expect(html).toContain('MCP client');
  expect(html).toContain('Check connection');
  expect(html).toContain('Copy');
});
it('the server-rendered configuration shows the endpoint placeholder before hydration', () => {
  const html = renderToStaticMarkup(<McpSection />);
  expect(html).toMatch(/<pre[^>]*aria-label="Claude Code configuration"[^>]*><code>\/api\/mcp<\/code><\/pre>/);
});
