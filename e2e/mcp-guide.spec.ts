import { test, expect } from '@playwright/test';

for (const theme of ['light', 'dark']) test(`Developer guide: ${theme}, copy, keyboard, held check and retry`, async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(theme => localStorage.setItem('dezfil-theme', theme), theme);
  const description = await (await request.get('/api/openapi.json')).json();
  const expectedCount = Object.values(description.paths).flatMap(item => Object.entries(item as Record<string, Record<string, unknown>>)).filter(([method, operation]) => /^(get|post|put|patch|delete)$/.test(method) && operation['x-tool'] !== false).length;
  await page.goto('/developer');
  const card = page.getByRole('region', { name: 'MCP server' });
  await expect(card).toBeVisible();
  const endpoint = new URL('/api/mcp', page.url()).href;
  await expect(card.locator('code').first()).toHaveText(endpoint);
  const selector = card.getByLabel('MCP client');
  await card.getByRole('link', { name: 'Client documentation' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(selector).toBeFocused();
  expect(await selector.evaluate(element => element.tagName)).toBe('SELECT');
  // macOS opens a closed native select on ArrowDown; selecting is platform-specific.
  await selector.selectOption('Codex');
  await expect(selector).toHaveValue('Codex');
  for (const client of ['Claude Code', 'Codex', 'Cursor', 'Claude Desktop']) {
    await selector.selectOption(client);
    const shown = await card.getByLabel(`${client} configuration`, { exact: true }).innerText();
    expect(shown).toContain(endpoint);
    await selector.focus();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Client documentation' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card.getByText('Copied', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  }
  await expect(card.getByText('Claude Desktop’s remote connectors connect from Anthropic’s cloud. They cannot reach this private instance over plain HTTP.')).toBeVisible();
  await expect(card.getByText('This instance has no authentication: anyone who can reach it can read, change, delete and publish its data through the API or MCP.')).toBeVisible();
  const productCalls: string[] = [], toolCalls: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && pathname !== '/api/mcp') productCalls.push(pathname);
    if (pathname === '/api/mcp' && request.postDataJSON()?.method === 'tools/call') toolCalls.push(request.postData()!);
  });
  await card.getByRole('button', { name: 'Check connection' }).click();
  await expect(card.getByText(`Connected. ${expectedCount} tools available.`)).toBeVisible();
  expect(productCalls).toEqual([]); expect(toolCalls).toEqual([]);
  let hold = true;
  const held: import('@playwright/test').Route[] = [];
  await page.route('**/api/mcp', async route => { if (hold) held.push(route); else await route.continue(); });
  const started = Date.now();
  await card.getByRole('button', { name: 'Check connection' }).click();
  await expect(card.getByText('Checking connection…')).toBeVisible();
  await expect(card.getByText('The connection check did not finish within 10 seconds.')).toBeVisible({ timeout: 11_500 });
  expect(Date.now() - started).toBeLessThan(11_500);
  await expect(card.getByRole('button', { name: 'Check connection' })).toBeEnabled();
  hold = false; for (const route of held) await route.abort().catch(() => {});
  await card.getByRole('button', { name: 'Check connection' }).click();
  await expect(card.getByText(`Connected. ${expectedCount} tools available.`)).toBeVisible();
  expect(productCalls).toEqual([]); expect(toolCalls).toEqual([]);
  await card.screenshot({ path: `test-results/mcp-guide-${theme}.png` });
});
