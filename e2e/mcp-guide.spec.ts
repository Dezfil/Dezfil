import { test, expect } from '@playwright/test';

for (const theme of ['light', 'dark']) test(`MCP server card in Settings: ${theme}, copy, keyboard, held check and retry`, async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(theme => localStorage.setItem('dezfil-theme', theme), theme);
  const description = await (await request.get('/api/openapi.json')).json();
  const expectedCount = Object.values(description.paths).flatMap(item => Object.entries(item as Record<string, Record<string, unknown>>)).filter(([method, operation]) => /^(get|post|put|patch|delete)$/.test(method) && operation['x-tool'] !== false).length;
  await page.goto('/settings/tokens');
  const card = page.getByRole('region', { name: 'MCP server' });
  await expect(card).toBeVisible();
  // The tab holds the tokens first, then the MCP server card.
  await expect(page.locator('[data-tab="tokens"] > section')).toHaveCount(2);
  expect(await page.locator('[data-tab="tokens"] > section').evaluateAll(sections => sections.map(section => section.id))).toEqual(['tokens', 'mcp']);
  const endpoint = new URL('/api/mcp', page.url()).href;
  await expect(card.getByText(endpoint, { exact: true })).toBeVisible();
  await expect(card.getByText('Create a token in the card above.', { exact: false })).toBeVisible();
  await expect(card.locator('a[href^="/settings"]')).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'API reference', exact: true })).toHaveAttribute('href', '/developer');
  await expect(card.getByRole('link', { name: 'API contract and edit revisions', exact: true })).toHaveAttribute('href', '/api/openapi.json');
  const selector = card.getByLabel('MCP client');
  await card.getByRole('link', { name: 'Client documentation' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(selector).toBeFocused();
  expect(await selector.evaluate(element => element.tagName)).toBe('SELECT');
  // macOS opens a closed native select on ArrowDown; selecting is platform-specific.
  await selector.selectOption('Codex');
  await expect(selector).toHaveValue('Codex');
  for (const client of ['Claude Code', 'Codex', 'Cursor']) {
    await selector.selectOption(client);
    const shown = await card.getByLabel(`${client} configuration`, { exact: true }).innerText();
    expect(shown).toContain(endpoint);
    expect(shown).toContain('DEZFIL_API_TOKEN');
    expect(shown).not.toContain('dz_token_');
    await selector.focus();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Client documentation' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card.getByText('Copied', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  }
  await selector.selectOption('Claude Desktop');
  await expect(card.getByText(/^Unsupported: remote custom connectors/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
  await expect(card.getByText('This checks your browser session. Other clients use their own API token.')).toBeVisible();
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

test('the API reference page has no MCP card, its own name, the old docs address, and a way to the card', async ({ page }) => {
  await page.goto('/docs');
  await expect(page).toHaveURL(/\/developer$/);
  await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'MCP server' })).toHaveCount(0);
  // No rail entry for it: the only way back in the shell is its own breadcrumb.
  await expect(page.getByRole('link', { name: 'Developer', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Set up an MCP client', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/tokens#mcp-heading$/);
  await expect(page.getByRole('region', { name: 'MCP server' })).toBeInViewport();
});
