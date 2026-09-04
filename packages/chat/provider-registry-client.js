// @ts-check

import harden from '@endo/harden';

// Client-side proxy for the daemon-side provider registry
// ([endopi-provider-registry-and-oauth § Provider registry]).
//
// Phase 4 of the chat-inventory-create-menu design ships this as a STATIC list
// of the maintainer's four named providers (plus the Ollama Remote variant),
// with hardcoded base URLs. The registry shape that endopi will land is in
// flight; when it does, this client becomes the adapter over whatever
// `listProviders()` / `listModels()` surface the daemon exposes, and the static
// table below becomes the offline fallback. Until then the new-agent wizard's
// provider pane (pane 2) reads straight from `PROVIDERS`.
//
// The design's discipline is "pick a provider by NAME, never by URL": the
// canonical base URL for each provider is held here and threaded into the
// manager form's `host` field on submit, so the user never types or sees a URL
// — except for the Ollama Remote variant, whose whole purpose is a
// user-supplied host, surfaced there as a first-class field ("running on
// another machine") rather than as a raw URL prompt.

/**
 * @typedef {'apiKey' | 'none'} AuthShape
 */

/**
 * @typedef {object} ProviderEntry
 * @property {string} id - Stable registry id.
 * @property {string} name - Human label shown in the picker.
 * @property {string} description - One-line description for the row.
 * @property {AuthShape} authShape - Whether an API key is required before use.
 * @property {string} baseUrl - Canonical OpenAI-compatible base URL. Threaded
 *   into the manager form's `host` field; never surfaced to the user unless
 *   `hostEditable` is true.
 * @property {boolean} hostEditable - When true (Ollama Remote), the wizard
 *   surfaces a host field the user fills; the `baseUrl` above is only a
 *   placeholder.
 * @property {boolean} localAutoDetect - When true (Ollama local), the base URL
 *   is a localhost endpoint the wizard auto-fills without asking.
 * @property {boolean} [attribution] - When true (OpenRouter), the row offers an
 *   optional attribution disclosure (HTTP-Referer / X-Title).
 * @property {string[]} models - Suggested model ids (a datalist, not a closed
 *   set — the user may type any). Live model discovery / Ollama pull is a
 *   later-phase follow-up per the design.
 * @property {string} [modelHint] - Extra guidance under the model field.
 */

/** @type {ProviderEntry[]} */
export const PROVIDERS = harden([
  {
    id: 'anthropic',
    name: 'Anthropic',
    description:
      'Claude models. Paste an API key (subscription sign-in later).',
    authShape: 'apiKey',
    baseUrl: 'https://api.anthropic.com/v1',
    hostEditable: false,
    localAutoDetect: false,
    models: [
      'claude-sonnet-4-6-20250514',
      'claude-opus-4-1-20250805',
      'claude-haiku-4-5-20251001',
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models. Paste an API key (subscription sign-in later).',
    authShape: 'apiKey',
    baseUrl: 'https://api.openai.com/v1',
    hostEditable: false,
    localAutoDetect: false,
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    description: 'Models running on this machine. No API key needed.',
    authShape: 'none',
    baseUrl: 'http://localhost:11434/v1',
    hostEditable: false,
    localAutoDetect: true,
    models: ['qwen3', 'llama3.3', 'gpt-oss', 'deepseek-r1'],
    modelHint:
      'Live model listing and one-click download are a follow-up; for now type an installed model name.',
  },
  {
    id: 'ollama-remote',
    name: 'Ollama Remote (running on another machine)',
    description: 'An Ollama server on a different host you can reach.',
    authShape: 'none',
    baseUrl: 'http://your-ollama-host:11434/v1',
    hostEditable: true,
    localAutoDetect: false,
    models: ['qwen3', 'llama3.3', 'gpt-oss', 'deepseek-r1'],
    modelHint: 'Point the host field at the machine running Ollama.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One key, many upstream providers. Paste an API key.',
    authShape: 'apiKey',
    baseUrl: 'https://openrouter.ai/api/v1',
    hostEditable: false,
    localAutoDetect: false,
    attribution: true,
    models: [
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-4o',
      'meta-llama/llama-3.3-70b-instruct',
    ],
  },
]);

/**
 * Look up a provider entry by id.
 *
 * @param {string} id
 * @returns {ProviderEntry | undefined}
 */
export const getProvider = id => PROVIDERS.find(p => p.id === id);
harden(getProvider);
