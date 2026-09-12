// @ts-check

import { Fail, makeError, q, X } from '@endo/errors';

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_ENV_VAR = 'OPENROUTER_API_KEY';
export const OPENROUTER_NPM = '@openrouter/ai-sdk-provider';
export const DEFAULT_MODEL = 'openrouter/deepseek/deepseek-v4.1-flash';
export const DEFAULT_LIMITS = harden({ context: 128_000, output: 8192 });

// The whole config travels in an environment variable, so keep it well under
// Linux MAX_ARG_STRLEN (131072 bytes) including the JSON envelope. Both
// budgets count UTF-8 bytes, not UTF-16 code units.
const MAX_PROMPT_BYTES = 48 * 1024;
const MAX_CONFIG_BYTES = 120 * 1024;
const MAX_MODEL_ID_CHARS = 256;
const MAX_NAME_CHARS = 1024;
const MAX_AGENT_NAME_CHARS = 64;
const MAX_MODEL_ENTRIES = 64;
const MAX_MCP_SERVERS = 16;
const MAX_MCP_COMMAND_PARTS = 64;
const MAX_MCP_PART_CHARS = 4096;

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// The vendor segment may be a stealth alias carrying a leading `~`.
const VENDOR_PATTERN = /^~?[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Names that collide with prototype members or with built-in opencode agents
// (whose prompts a custom entry would overwrite).
const RESERVED_AGENT_NAMES = harden([
  'constructor',
  'prototype',
  '__proto__',
  'tostring',
  'valueof',
  'hasownproperty',
  'isprototypeof',
  'propertyisenumerable',
  'tolocalestring',
  'build',
  'plan',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
]);

const utf8Encoder = new TextEncoder();
const utf8Bytes = value => utf8Encoder.encode(value).byteLength;

/**
 * @param {unknown} value
 * @param {string} label
 */
const assertPlainRecord = (value, label) => {
  (value && typeof value === 'object' && !Array.isArray(value)) ||
    Fail`${q(label)} must be a record`;
  const prototype = Object.getPrototypeOf(value);
  prototype === Object.prototype ||
    prototype === null ||
    Fail`${q(label)} must be a plain record`;
  return /** @type {Record<string, unknown>} */ (value);
};

/**
 * @param {unknown} key
 * @param {string} label
 */
const assertSafeKey = (key, label) => {
  if (!(
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_MODEL_ID_CHARS
  )) {
    Fail`${q(label)} must be a bounded string`;
  }
  const value = /** @type {string} */ (key);
  (value !== '__proto__' && value !== 'constructor' && value !== 'prototype') ||
    Fail`${q(label)} is a reserved name`;
  return value;
};

/**
 * Validate a provider-scoped OpenRouter model id (`<vendor>/<model>`).
 *
 * @param {string} id
 * @param {string} label
 */
const assertProviderModelId = (id, label) => {
  const segments = id.split('/');
  segments.length >= 2 || Fail`${q(label)} must be <vendor>/<model>`;
  segments.every(segment => segment.length > 0) ||
    Fail`${q(label)} has an empty segment`;
  VENDOR_PATTERN.test(segments[0]) ||
    Fail`${q(label)} has an invalid vendor segment`;
  segments.slice(1).every(segment => SEGMENT_PATTERN.test(segment)) ||
    Fail`${q(label)} has an invalid model segment`;
  return id;
};

/**
 * Split an `openrouter/<vendor>/<model>` reference into the provider-scoped
 * model id that the OpenRouter API expects.
 *
 * @param {unknown} ref
 * @param {string} [label]
 * @returns {string}
 */
export const parseModelRef = (ref, label = 'model') => {
  if (!(typeof ref === 'string' && ref.length <= MAX_MODEL_ID_CHARS)) {
    Fail`${q(label)} must be a bounded string`;
  }
  const value = /** @type {string} */ (ref);
  value.startsWith(`${OPENROUTER_PROVIDER_ID}/`) ||
    Fail`${q(label)} must start with ${q(`${OPENROUTER_PROVIDER_ID}/`)}`;
  return assertProviderModelId(
    value.slice(OPENROUTER_PROVIDER_ID.length + 1),
    label,
  );
};
harden(parseModelRef);

/**
 * Accept either a provider-scoped id or a full ref as a catalog key and return
 * the canonical provider-scoped id.
 *
 * @param {string} key
 * @param {string} label
 */
const normalizeCatalogModelId = (key, label) => {
  const id = key.startsWith(`${OPENROUTER_PROVIDER_ID}/`)
    ? key.slice(OPENROUTER_PROVIDER_ID.length + 1)
    : key;
  return assertProviderModelId(id, label);
};

/**
 * @param {unknown} baseUrl
 * @param {string} label
 */
const normalizeBaseUrl = (baseUrl, label) => {
  if (typeof baseUrl !== 'string') {
    Fail`${q(label)} must be a string`;
  }
  const value = /** @type {string} */ (baseUrl);
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw makeError(X`${q(label)} must be a valid URL: ${q(`${error}`)}`);
  }
  url.protocol === 'https:' || Fail`${q(label)} must use https`;
  url.hostname === 'openrouter.ai' ||
    Fail`${q(label)} must point at openrouter.ai`;
  url.port === '' || Fail`${q(label)} must use the default https port`;
  (url.username === '' && url.password === '') ||
    Fail`${q(label)} must not carry credentials`;
  url.pathname === '/api/v1' ||
    url.pathname === '/api/v1/' ||
    Fail`${q(label)} must be the /api/v1 endpoint`;
  (url.search === '' && url.hash === '') ||
    Fail`${q(label)} must not carry a query or fragment`;
  return `${url.origin}/api/v1`;
};

/**
 * @param {unknown} agentName
 * @param {string} label
 */
const normalizeAgentName = (agentName, label) => {
  if (!(
    typeof agentName === 'string' &&
    agentName.length > 0 &&
    agentName.length <= MAX_AGENT_NAME_CHARS &&
    AGENT_NAME_PATTERN.test(agentName)
  )) {
    Fail`${q(label)} must be a bounded lowercase name`;
  }
  const value = /** @type {string} */ (agentName);
  RESERVED_AGENT_NAMES.includes(value.toLowerCase()) &&
    Fail`${q(label)} is reserved`;
  return value;
};

/**
 * @param {unknown} limits
 * @param {string} label
 */
const normalizeLimits = (limits, label) => {
  const { context, output } = assertPlainRecord(limits, label);
  if (!(
    typeof context === 'number' &&
    Number.isSafeInteger(context) &&
    context > 0
  )) {
    Fail`${q(label)} context must be a positive integer`;
  }
  if (!(
    typeof output === 'number' &&
    Number.isSafeInteger(output) &&
    output > 0
  )) {
    Fail`${q(label)} output must be a positive integer`;
  }
  const ctx = /** @type {number} */ (context);
  const out = /** @type {number} */ (output);
  ctx > out || Fail`${q(label)} context must exceed output`;
  return harden({ context: ctx, output: out });
};

/**
 * @param {unknown} entry
 * @param {string} label
 */
const normalizeModelEntry = (entry, label) => {
  const record = assertPlainRecord(entry, label);
  Object.keys(record).every(key => key === 'name' || key === 'limit') ||
    Fail`${q(label)} has unknown fields`;
  const { name } = record;
  name === undefined ||
    (typeof name === 'string' &&
      name.length > 0 &&
      name.length <= MAX_NAME_CHARS) ||
    Fail`${q(label)} name is invalid`;
  const limit =
    record.limit === undefined
      ? DEFAULT_LIMITS
      : normalizeLimits(record.limit, `${label} limit`);
  return harden({ ...(name === undefined ? {} : { name }), limit });
};

/**
 * @param {unknown} environment
 * @param {string} label
 */
const normalizeMcpEnvironment = (environment, label) => {
  const record = assertPlainRecord(environment, label);
  const entries = Object.entries(record);
  entries.length <= MAX_MCP_SERVERS || Fail`${q(label)} has too many entries`;
  const normalized = /** @type {Record<string, string>} */ ({});
  for (const [name, value] of entries) {
    MCP_SERVER_NAME_PATTERN.test(name) ||
      Fail`${q(label)} key ${q(name)} is invalid`;
    if (!(typeof value === 'string' && value.length <= MAX_MCP_PART_CHARS)) {
      Fail`${q(label)}[${q(name)}] must be a bounded string`;
    }
    normalized[name] = /** @type {string} */ (value);
  }
  return harden(normalized);
};

/**
 * @param {unknown} servers
 * @param {string} label
 */
const normalizeMcpServers = (servers, label) => {
  if (servers === undefined) return undefined;
  const record = assertPlainRecord(servers, label);
  const entries = Object.entries(record);
  entries.length <= MAX_MCP_SERVERS || Fail`${q(label)} has too many entries`;
  const normalized = /** @type {Record<string, unknown>} */ ({});
  for (const [name, value] of entries) {
    MCP_SERVER_NAME_PATTERN.test(name) ||
      Fail`${q(label)} key ${q(name)} is invalid`;
    const entry = assertPlainRecord(value, `${label}[${q(name)}]`);
    Object.keys(entry).every(key =>
      ['type', 'command', 'enabled', 'environment'].includes(key),
    ) || Fail`${q(label)}[${q(name)}] has unknown fields`;
    entry.type === 'local' ||
      Fail`${q(label)}[${q(name)}] must be a local server`;
    if (!(
      Array.isArray(entry.command) &&
      entry.command.length > 0 &&
      entry.command.length <= MAX_MCP_COMMAND_PARTS
    )) {
      Fail`${q(label)}[${q(name)}] command must be a bounded array`;
    }
    const command = /** @type {unknown[]} */ (entry.command);
    command.every(
      part =>
        typeof part === 'string' &&
        part.length > 0 &&
        part.length <= MAX_MCP_PART_CHARS,
    ) || Fail`${q(label)}[${q(name)}] command parts must be bounded strings`;
    const enabled = entry.enabled === undefined ? true : entry.enabled;
    typeof enabled === 'boolean' ||
      Fail`${q(label)}[${q(name)}] enabled must be a boolean`;
    normalized[name] = harden({
      type: 'local',
      command: harden(command.map(part => /** @type {string} */ (part))),
      enabled,
      ...(entry.environment === undefined
        ? {}
        : {
            environment: normalizeMcpEnvironment(
              entry.environment,
              `${label}[${q(name)}].environment`,
            ),
          }),
    });
  }
  return harden(normalized);
};

/**
 * Build the JSON value for the daemon's `OPENCODE_CONFIG_CONTENT`.
 *
 * The provider block is the authoritative endpoint and model list for this
 * session: it pins `https://openrouter.ai/api/v1`, the exact provider-scoped
 * model ids this backend offers, and the env var that supplies the key. It
 * cannot, by itself, stop a writable lower config layer from adding
 * `options.apiKey` or an alternate SDK package, so the caller must also run
 * with project config disabled, an isolated global config dir, and
 * `OPENCODE_AUTH_CONTENT='{}'` (see DESIGN.md).
 *
 * A config agent's `prompt` replaces opencode's provider base prompt, so the
 * session persona must be self-contained.
 *
 * @param {object} [options]
 * @param {string} [options.model] full opencode ref, e.g. `openrouter/<vendor>/<model>`
 * @param {string} [options.smallModel] ref used for titles/summaries; defaults to `model`
 * @param {string} [options.agentName]
 * @param {string} [options.systemPrompt]
 * @param {Record<string, { name?: string, limit?: { context: number, output: number } }>} [options.models]
 * @param {string} [options.baseUrl]
 * @param {Record<string, unknown>} [options.mcpServers]
 */
export const makeOpencodeConfig = ({
  model = DEFAULT_MODEL,
  smallModel = model,
  agentName = 'floot',
  systemPrompt,
  models,
  baseUrl = OPENROUTER_BASE_URL,
  mcpServers,
} = {}) => {
  const providerModel = parseModelRef(model, 'model');
  const smallProviderModel = parseModelRef(smallModel, 'smallModel');
  const resolvedAgentName = normalizeAgentName(agentName, 'agentName');
  if (systemPrompt !== undefined) {
    typeof systemPrompt === 'string' || Fail`systemPrompt must be a string`;
    systemPrompt.length > 0 || Fail`systemPrompt must not be empty`;
    utf8Bytes(systemPrompt) <= MAX_PROMPT_BYTES ||
      Fail`systemPrompt is too large for the config env var`;
  }
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl, 'baseUrl');
  const resolvedMcp = normalizeMcpServers(mcpServers, 'mcpServers');

  /** @type {Record<string, ReturnType<typeof normalizeModelEntry>>} */
  const catalog = {};
  if (models !== undefined) {
    const record = assertPlainRecord(models, 'models');
    const entries = Object.entries(record);
    entries.length <= MAX_MODEL_ENTRIES || Fail`models has too many entries`;
    for (const [rawKey, entry] of entries) {
      const key = assertSafeKey(rawKey, 'models key');
      const id = normalizeCatalogModelId(key, `models[${q(rawKey)}]`);
      Object.hasOwn(catalog, id) &&
        Fail`models has a duplicate entry for ${q(id)}`;
      catalog[id] = normalizeModelEntry(entry, `models[${q(rawKey)}]`);
    }
  }
  for (const id of [providerModel, smallProviderModel]) {
    if (!Object.hasOwn(catalog, id)) {
      catalog[id] = normalizeModelEntry({ name: id }, `models[${q(id)}]`);
    }
  }
  const whitelist = harden([
    ...new Set([providerModel, smallProviderModel, ...Object.keys(catalog)]),
  ]);

  const config = {
    share: 'disabled',
    model,
    small_model: smallModel,
    default_agent: resolvedAgentName,
    // Let the bridge answer ordinary permission asks; only the doom-loop
    // continuation needs a standing allow so a turn cannot hang.
    permission: { doom_loop: 'allow' },
    provider: {
      [OPENROUTER_PROVIDER_ID]: {
        npm: OPENROUTER_NPM,
        env: [OPENROUTER_ENV_VAR],
        options: { baseURL: resolvedBaseUrl },
        whitelist,
        models: catalog,
      },
    },
    agent: {
      [resolvedAgentName]: {
        ...(systemPrompt === undefined ? {} : { prompt: systemPrompt }),
        disable: false,
        mode: 'primary',
      },
    },
    ...(resolvedMcp === undefined ? {} : { mcp: resolvedMcp }),
  };

  utf8Bytes(JSON.stringify(config)) <= MAX_CONFIG_BYTES ||
    Fail`opencode config is too large for the config env var`;
  return harden(config);
};
harden(makeOpencodeConfig);
