// @ts-check

import { makeError } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { createProvider as createLalProvider } from '@endo/lal/providers/index.js';
import { M } from '@endo/patterns';

/**
 * @typedef {object} ProviderConfig
 * @property {'openai' | 'anthropic' | 'local'} kind
 * @property {string} host
 * @property {string} model
 * @property {string} [maxTokens]
 * @property {string} [maxMessages]
 */

const ProviderI = M.interface('FaeProviderService', {
  chat: M.callWhen(M.arrayOf(M.record()), M.arrayOf(M.record())).returns(
    M.record(),
  ),
  getInfo: M.call().returns(M.record()),
  help: M.call().returns(M.string()),
});

/** @param {ProviderConfig} config */
export const validateProviderConfig = config => {
  const { kind, model, maxTokens, maxMessages } = config;
  if (!['openai', 'anthropic', 'local'].includes(kind)) {
    throw makeError('Provider kind must be openai, anthropic, or local.');
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 256) {
    throw makeError('An explicit provider model is required.');
  }
  // Configuration contains only public routing metadata. Credentials are capabilities.
  if (
    Object.keys(config).some(
      key =>
        !['kind', 'host', 'model', 'maxTokens', 'maxMessages'].includes(key),
    )
  ) {
    throw makeError('Unsupported provider configuration field.');
  }
  let url;
  try {
    url = new URL(config.host);
  } catch {
    throw makeError('An explicit provider endpoint URL is required.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw makeError(
      'Provider endpoint must be HTTP(S) without credentials, query, or fragment.',
    );
  }
  const host = url.href.replace(/\/$/, '');
  if (
    (kind === 'openai' && host !== 'https://api.openai.com/v1') ||
    (kind === 'anthropic' && host !== 'https://api.anthropic.com')
  ) {
    throw makeError(
      'Cloud provider endpoint must be its canonical HTTPS API endpoint.',
    );
  }
  // Lal dispatches by URL substring; reject local URLs that would select a cloud SDK.
  if (
    kind === 'local' &&
    /anthropic\.com|googleapis\.com|generativelanguage/.test(host)
  ) {
    throw makeError('Local endpoint must select a local provider protocol.');
  }
  for (const limit of [maxTokens, maxMessages]) {
    if (
      limit !== undefined &&
      (typeof limit !== 'string' || !/^[1-9][0-9]{0,6}$/.test(limit))
    ) {
      throw makeError(
        'Provider limits must be positive decimal strings up to seven digits.',
      );
    }
  }
  return harden({ kind, host, model, maxTokens, maxMessages });
};
harden(validateProviderConfig);

/** @param {unknown} encoded */
const decodeCredential = encoded => {
  // Bound before decoding; canonical padding rejects ambiguous or ignored bytes.
  if (
    typeof encoded !== 'string' ||
    encoded.length > 10_924 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw makeError(
      'Provider credential must be valid base64 containing at most 8192 UTF-8 bytes.',
    );
  }
  try {
    const binary = globalThis.atob(encoded);
    if (
      !binary.length ||
      binary.length > 8192 ||
      globalThis.btoa(binary) !== encoded
    )
      throw Error('invalid');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    let token;
    try {
      token = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
    if (
      !token.trim() ||
      Array.from(token).some(
        character =>
          character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      )
    )
      throw Error('invalid');
    return token;
  } catch {
    throw makeError(
      'Provider credential must contain nonempty, valid UTF-8 without control characters.',
    );
  }
};

/**
 * A trusted provider has one destination and, for cloud APIs, one SecretBlob.
 * It resolves and reads that blob for every request so rotation and revocation
 * take effect without replacing the story session or its conversation.
 *
 * @param {any} powers Namespace containing only `llm-auth-secret` for cloud providers.
 * @param {ProviderConfig} config Public routing configuration; never an API key.
 * @param {{ createProvider?: typeof createLalProvider }} [options]
 */
export const makeProviderService = (
  powers,
  config,
  { createProvider = createLalProvider } = {},
) => {
  const { kind, host, model, maxTokens, maxMessages } =
    validateProviderConfig(config);
  const authRequired = kind !== 'local';
  const info = harden({ kind, host, model, authRequired });
  return makeExo('FaeProviderService', ProviderI, {
    async chat(messages, tools) {
      let authToken;
      if (authRequired) {
        let encoded;
        try {
          const secret = await E(powers).lookup('llm-auth-secret');
          encoded = await E(secret).readBase64();
        } catch {
          throw makeError(
            'Provider credential unavailable or revoked. Refresh its managed secret and retry.',
          );
        }
        authToken = decodeCredential(encoded);
      }
      try {
        const provider = createProvider({
          LAL_HOST: host,
          LAL_MODEL: model,
          LAL_AUTH_TOKEN: authToken,
          LAL_MAX_TOKENS: maxTokens,
          LAL_MAX_MESSAGES: maxMessages,
        });
        return harden(await provider.chat([...messages], [...tools]));
      } catch (error) {
        // SDK errors may contain request headers or credential fragments. Never
        // return, log, or attach the original error across this authority boundary.
        // Only fixed classifications of numeric HTTP statuses cross it.
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? error.status
            : undefined;
        if (status === 401 || status === 403)
          throw makeError(
            'Provider request failed: authentication or account access denied.',
          );
        if (status === 404)
          throw makeError(
            'Provider request failed: selected model or endpoint unavailable.',
          );
        if (status === 429)
          throw makeError(
            'Provider request failed: account quota or rate limit reached.',
          );
        if (status === 400)
          throw makeError(
            'Provider request failed: model rejected the request format.',
          );
        throw makeError(
          'Provider request failed. Check the selected model, endpoint, and managed credential, then retry.',
        );
      }
    },
    getInfo: () => info,
    help: () =>
      'Chat with the configured model. getInfo returns public routing metadata; credentials remain private and are refreshed for every request.',
  });
};
harden(makeProviderService);

/**
 * @param {any} powers
 * @param {unknown} context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (powers, context, { env = {} } = {}) =>
  makeProviderService(powers, {
    kind: /** @type {ProviderConfig['kind']} */ (env.PROVIDER_KIND),
    host: env.PROVIDER_HOST,
    model: env.PROVIDER_MODEL,
    maxTokens: env.PROVIDER_MAX_TOKENS,
    maxMessages: env.PROVIDER_MAX_MESSAGES,
  });
harden(make);
