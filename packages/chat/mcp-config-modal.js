// @ts-check

import harden from '@endo/harden';

import { Fragment, h, renderConfined } from './setup-preact-container.js';

/**
 * The warning shown beside the configuration block. The bearer is the
 * agent's formula identifier, which is the agent's full authority
 * (designs/endo-gateway-mcp.md, Affordance 2).
 */
export const MCP_TOKEN_WARNING =
  "This token is the agent's full authority. Treat it like an SSH key.";
harden(MCP_TOKEN_WARNING);

/**
 * The MCP endpoint URL for a page served from `origin`. The reverse proxy in
 * front of the gateway routes `/mcp` to the `endo-mcp-http` termination.
 *
 * @param {string} origin - e.g. `https://endo.example`
 * @returns {string}
 */
export const mcpUrlForOrigin = origin => `${origin.replace(/\/+$/, '')}/mcp`;
harden(mcpUrlForOrigin);

/**
 * Render the `mcpServers` block an MCP client (Claude Desktop, Cursor, and
 * the like) reads.
 *
 * @param {object} options
 * @param {string} options.name - the server key, the agent's pet name
 * @param {string} options.url - the `/mcp` endpoint
 * @param {string} options.formulaId - the agent's formula identifier
 * @returns {string}
 */
export const formatMcpConfig = ({ name, url, formulaId }) =>
  JSON.stringify(
    {
      mcpServers: {
        [name]: {
          url,
          headers: { Authorization: `Bearer ${formulaId}` },
        },
      },
    },
    null,
    2,
  );
harden(formatMcpConfig);

/**
 * @typedef {object} McpModalState
 * @property {boolean} open
 * @property {string} title
 * @property {string | null} config - the rendered block, once resolved
 * @property {string | null} error
 * @property {'copied' | 'failed' | null} copyStatus
 */

/**
 * @param {object} props
 * @param {McpModalState} props.state
 * @param {() => void} props.onClose
 * @param {() => void} props.onCopy
 */
const McpConfigModalBody = ({ state, onClose, onCopy }) => {
  if (!state.open) return null;
  let body;
  if (state.error !== null) {
    body = h('div', { class: 'add-space-error' }, state.error);
  } else if (state.config === null) {
    body = h('p', { class: 'mcp-config-loading' }, 'Looking up the agent…');
  } else {
    body = h(
      Fragment,
      null,
      h(
        'p',
        { class: 'mcp-config-hint' },
        "Paste into your MCP client's config (Claude Desktop, etc.):",
      ),
      h('pre', { class: 'mcp-config-block' }, state.config),
      h('p', { class: 'mcp-config-warning', role: 'alert' }, MCP_TOKEN_WARNING),
    );
  }
  let copyLabel = 'Copy';
  if (state.copyStatus === 'copied') copyLabel = 'Copied';
  if (state.copyStatus === 'failed') copyLabel = 'Copy failed';
  return h(
    Fragment,
    null,
    h('div', { class: 'add-space-backdrop', onClick: onClose }),
    h(
      'div',
      { class: 'add-space-modal mcp-config-modal' },
      h(
        'div',
        { class: 'add-space-header' },
        h('h2', { class: 'add-space-title' }, state.title),
        h(
          'button',
          {
            type: 'button',
            class: 'add-space-close',
            title: 'Close (Esc)',
            onClick: onClose,
          },
          '×',
        ),
      ),
      h('div', { class: 'add-space-form' }, body),
      h(
        'div',
        { class: 'add-space-actions' },
        h(
          'button',
          { type: 'button', class: 'add-space-cancel', onClick: onClose },
          'Close',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'add-space-submit mcp-config-copy',
            disabled: state.config === null,
            onClick: onCopy,
          },
          copyLabel,
        ),
      ),
    ),
  );
};
harden(McpConfigModalBody);

/**
 * @typedef {object} McpConfigModalAPI
 * @property {(space: { name: string, profilePath: string[] }) => Promise<void>} show
 * @property {() => void} hide
 * @property {() => boolean} isVisible
 */

/**
 * Create the modal that shows an agent's MCP client configuration. `show`
 * looks the agent's formula identifier up with `identify(...profilePath)`,
 * the same call Chat uses elsewhere, so no new identifier is minted.
 *
 * @param {object} options
 * @param {HTMLElement} options.$container
 * @param {(...petNamePath: string[]) => Promise<string | undefined>} options.identify
 * @param {string} options.url - the `/mcp` endpoint to advertise
 * @param {(text: string) => Promise<void>} [options.writeClipboard]
 * @returns {McpConfigModalAPI}
 */
export const createMcpConfigModal = ({
  $container,
  identify,
  url,
  writeClipboard = text => navigator.clipboard.writeText(text),
}) => {
  const $mount = document.createElement('div');
  $mount.style.display = 'contents';

  /** @type {McpModalState} */
  let state = harden({
    open: false,
    title: 'MCP',
    config: null,
    error: null,
    copyStatus: null,
  });
  // Each `show` bumps the generation so a slow lookup for a space the user has
  // since closed or replaced cannot paint over the current one.
  let generation = 0;

  /** @param {Partial<McpModalState>} patch */
  const update = patch => {
    state = harden({ ...state, ...patch });
    rerender();
  };

  const hide = () => {
    generation += 1;
    document.removeEventListener('keydown', handleEscape);
    update({ open: false });
    $container.style.display = 'none';
  };

  /** @param {KeyboardEvent} e */
  const handleEscape = e => {
    if (e.key === 'Escape' && state.open) hide();
  };

  const copy = () => {
    const { config } = state;
    if (config === null) return;
    writeClipboard(config).then(
      () => update({ copyStatus: 'copied' }),
      () => update({ copyStatus: 'failed' }),
    );
  };

  function rerender() {
    renderConfined(
      h(McpConfigModalBody, { state, onClose: hide, onCopy: copy }),
      $mount,
    );
  }

  /** @param {{ name: string, profilePath: string[] }} space */
  const show = async ({ name, profilePath }) => {
    generation += 1;
    const mine = generation;
    const petName = profilePath[profilePath.length - 1] || name;
    update({
      open: true,
      title: `MCP: ${name}`,
      config: null,
      error: null,
      copyStatus: null,
    });
    $container.style.display = 'flex';
    document.addEventListener('keydown', handleEscape);
    try {
      const formulaId = await identify(...profilePath);
      if (mine !== generation) return;
      if (formulaId === undefined) {
        update({ error: `No agent is named ${profilePath.join('/')}.` });
        return;
      }
      update({ config: formatMcpConfig({ name: petName, url, formulaId }) });
    } catch (err) {
      if (mine !== generation) return;
      update({ error: `Could not look up the agent: ${String(err)}` });
    }
  };

  const isVisible = () => state.open;

  $container.appendChild($mount);
  $container.style.display = 'none';
  rerender();

  return harden({ show, hide, isVisible });
};
harden(createMcpConfigModal);
