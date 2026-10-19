/**
 * MCP configuration smoke test (designs/endo-gateway-mcp.md, Phase 4).
 *
 * "+ Add agent" opens the new-profile form; the new space's context menu then
 * offers "MCP", which shows the `mcpServers` block carrying the agent's
 * formula identifier as its bearer.
 *
 * Requires a running Endo daemon (the Vite dev server starts one).
 */
// @ts-nocheck - E2E test with browser globals

import { test, expect } from '@playwright/test';

const suffix = Date.now().toString(36);

test('Add agent, then copy its MCP config', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.waitForSelector('#spaces-gutter', { timeout: 30_000 });

  await page.locator('.add-agent-button').click();
  const handle = `mcp-${suffix}`;
  await page.locator('#handle-name').fill(handle);
  await page.locator('.add-space-submit').click();
  await page.waitForSelector('.add-space-modal', {
    state: 'hidden',
    timeout: 30_000,
  });

  await page.locator('.space-item.active').click({ button: 'right' });
  await page.locator('[data-action="mcp"]').click();

  const block = page.locator('.mcp-config-block');
  await expect(block).toBeVisible({ timeout: 10_000 });
  const config = JSON.parse(await block.textContent());
  const [server] = Object.values(config.mcpServers);
  expect(server.url).toMatch(/\/mcp$/);
  expect(server.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}:/);
  await expect(page.locator('.mcp-config-warning')).toHaveText(
    /Treat it like an SSH key/,
  );

  await page.locator('.mcp-config-copy').click();
  await expect(page.locator('.mcp-config-copy')).toHaveText('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)).toEqual(config);
});
