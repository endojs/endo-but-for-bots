// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { createDOM, tick } from '../helpers/dom-setup.js';
import {
  MCP_TOKEN_WARNING,
  createMcpConfigModal,
  formatMcpConfig,
  mcpUrlForOrigin,
} from '../../mcp-config-modal.js';

const { document: testDocument } = createDOM();

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = fn =>
    globalThis.setTimeout(() => fn(0), 0);
  globalThis.cancelAnimationFrame = id => globalThis.clearTimeout(id);
}

const waitFor = async (predicate, { timeout = 3000, step = 20 } = {}) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return;
    // eslint-disable-next-line no-await-in-loop
    await tick(step);
  }
};

const FORMULA_ID = `${'a'.repeat(64)}:${'b'.repeat(64)}`;

const mountModal = (t, options) => {
  testDocument.body.innerHTML = '';
  const $container = testDocument.createElement('div');
  testDocument.body.appendChild($container);
  t.teardown(() => $container.remove());
  const modal = createMcpConfigModal({
    $container,
    url: 'https://endo.example/mcp',
    ...options,
  });
  return { $container, modal };
};

test('mcpUrlForOrigin appends /mcp once', t => {
  t.is(mcpUrlForOrigin('https://endo.example'), 'https://endo.example/mcp');
  t.is(mcpUrlForOrigin('https://endo.example/'), 'https://endo.example/mcp');
});

test('formatMcpConfig renders the mcpServers block', t => {
  const parsed = JSON.parse(
    formatMcpConfig({
      name: 'alice',
      url: 'https://endo.example/mcp',
      formulaId: FORMULA_ID,
    }),
  );
  t.deepEqual(parsed, {
    mcpServers: {
      alice: {
        url: 'https://endo.example/mcp',
        headers: { Authorization: `Bearer ${FORMULA_ID}` },
      },
    },
  });
});

test.serial(
  'show identifies the agent and renders block and warning',
  async t => {
    const calls = [];
    const { $container, modal } = mountModal(t, {
      identify: async (...path) => {
        calls.push(path);
        return FORMULA_ID;
      },
    });
    t.is($container.style.display, 'none');
    await modal.show({ name: 'Alice', profilePath: ['alice'] });
    await waitFor(() => !!$container.querySelector('.mcp-config-block'));
    t.deepEqual(calls, [['alice']]);
    t.is($container.style.display, 'flex');
    const block = $container.querySelector('.mcp-config-block').textContent;
    t.true(block.includes(`"Authorization": "Bearer ${FORMULA_ID}"`));
    t.true(block.includes('"alice"'));
    t.is(
      $container.querySelector('.mcp-config-warning').textContent,
      MCP_TOKEN_WARNING,
    );
  },
);

test.serial('Copy writes the block to the clipboard', async t => {
  const written = [];
  const { $container, modal } = mountModal(t, {
    identify: async () => FORMULA_ID,
    writeClipboard: async text => {
      written.push(text);
    },
  });
  await modal.show({ name: 'Alice', profilePath: ['alice'] });
  await waitFor(() => !!$container.querySelector('.mcp-config-block'));
  $container.querySelector('.mcp-config-copy').click();
  await waitFor(
    () => $container.querySelector('.mcp-config-copy').textContent === 'Copied',
  );
  t.is(written.length, 1);
  t.is(JSON.parse(written[0]).mcpServers.alice.url, 'https://endo.example/mcp');
  t.is($container.querySelector('.mcp-config-copy').textContent, 'Copied');
});

test.serial('an unknown name shows an error and no Copy', async t => {
  const { $container, modal } = mountModal(t, {
    identify: async () => undefined,
  });
  await modal.show({ name: 'Ghost', profilePath: ['ghost'] });
  await waitFor(() => !!$container.querySelector('.add-space-error'));
  t.truthy($container.querySelector('.add-space-error'));
  t.is($container.querySelector('.mcp-config-block'), null);
  t.true($container.querySelector('.mcp-config-copy').disabled);
});

test.serial('hide closes the modal', async t => {
  const { $container, modal } = mountModal(t, {
    identify: async () => FORMULA_ID,
  });
  await modal.show({ name: 'Alice', profilePath: ['alice'] });
  modal.hide();
  await tick(20);
  t.false(modal.isVisible());
  t.is($container.style.display, 'none');
  t.is($container.querySelector('.mcp-config-modal'), null);
});
