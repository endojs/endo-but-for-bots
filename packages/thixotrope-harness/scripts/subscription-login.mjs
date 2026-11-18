#!/usr/bin/env node
// @ts-check
/**
 * Operator sign-in for a subscription pool member, and large secret values
 * from the command line (M4 W4.6; `designs/m4-interfaces.md` 7, 9.1 item 3;
 * R7-16, R7-29, R8-35..R8-37; `[real-provider]`, owner-run).
 *
 * Both paths write through the agent host's `SecretWriter` with a **sealed
 * box** (`SecretsAdmin.openWriter()` -> `publicKey()` -> `sealTo` ->
 * `replace(secret, box, expectedGeneration?)`), so the hub and the control
 * socket carry ciphertext only (D-6). Nothing is written to a file and no
 * token or value is printed or logged.
 *
 * - `signIn({ client, secret, provider, ... })`: the provider's
 *   authorization-code flow with PKCE (S256), as claude-sandbox
 *   `subscription-login.js` (1315bef86) does it: the authorization URL is
 *   handed to `prompt`, which answers the pasted `code#state`; the code is
 *   exchanged at the token endpoint (redirects refused, bounded answer) and
 *   the credential is written in the stored form (`credentials.js`), so the
 *   member's first round uses it and its renewal starts from it. Claude's
 *   endpoints and public client id are the reference's defaults; Codex has
 *   no reference sign-in flow, so its `authorizeUrl` and `redirectUri` must
 *   be given.
 * - `writeValue({ client, secret, value, expectedGeneration? })`: a UTF-8
 *   value of at most `secretValueBytes` (1,048,576 bytes), sealed and
 *   written. The Secrets panel sends a person here when a value is over
 *   `browserSecretBytes`.
 *
 * `client` is a control client on the harness workspace (`provision.mjs`):
 * `client.call('lookup', 'agentHostAdmin')` answers `AgentHostAdmin`.
 *
 * CLI (the Secret is named by label: the CLI boundary, F.2 c):
 *
 *   node scripts/subscription-login.mjs STATE --secret-label LABEL \
 *     (--value-file PATH | --sign-in claude|codex [--authorize-url URL]
 *      [--token-url URL] [--redirect-uri URL]) \
 *     [--expected-generation N] [--workspace w]
 */
import './_init.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import url from 'node:url';

// Everything that needs the locked-down globals is imported after
// `_init.mjs` has run (a static import of an Endo package is evaluated
// before `_init.mjs`'s top-level await settles when this file is the entry).
// The credential parser reads guest texts and guards: the guest prelude
// (idempotent; already there under ses-ava tests).
(await import('./guest-prelude.js')).installGuestPrelude();
const [
  { E },
  { limits },
  { sealTo },
  { codexAccountOf, formatCredential, jwtClaims },
  { providerEndpoints },
  { names },
  { secretsByLabel },
] = await Promise.all([
  import('@endo/far'),
  // eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
  import('../guest/lib/limits.js'),
  import('../resources/agent-host/impl/secrets/seal.js'),
  import('../resources/agent-host/impl/subscriptions/credentials.js'),
  import('../resources/agent-host/impl/subscriptions/index.js'),
  import('./provision-steps.js'),
  import('./provision-steps/40-subscriptions.js'),
]);

/** Token answers are small JSON; anything larger is refused. */
const ANSWER_BYTES = 64 * 1024;
/** The token exchange's time box (the reference's). */
const EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * The providers' sign-in constants (claude-sandbox `subscription-login.js`,
 * 1315bef86). Codex: the token endpoint and client id of codex-sandbox
 * `subscription-auth.js`; no authorization page in the reference.
 */
export const signInDefaults = harden({
  claude: {
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: providerEndpoints.claude.tokenUrl,
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    clientId: providerEndpoints.claude.clientId,
    scopes: harden([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ]),
  },
  codex: {
    authorizeUrl: undefined,
    tokenUrl: providerEndpoints.codex.tokenUrl,
    redirectUri: undefined,
    clientId: providerEndpoints.codex.clientId,
    scopes: harden(['openid', 'profile', 'email', 'offline_access']),
  },
});

/**
 * The Secrets manager through the control client.
 * @param {any} client
 */
const secretsAdminOf = async client => {
  const admin = await client.call('lookup', names.agentHost);
  if (admin === undefined) throw Error('No agent host here');
  return E(admin).getSecrets();
};

/**
 * Write `value` into `secret` as a sealed box (D-6).
 * @param {object} options
 * @param {any} options.client a control client on the harness workspace
 * @param {any} options.secret the `Secret` presence
 * @param {string} options.value UTF-8 text
 * @param {number} [options.expectedGeneration]
 * @returns {Promise<{ generation: number }>}
 */
export const writeValue = async ({
  client,
  secret,
  value,
  expectedGeneration,
}) => {
  if (typeof value !== 'string') throw TypeError('A secret value is text');
  if (Buffer.byteLength(value, 'utf8') > limits.secretValueBytes)
    throw Error(
      `A secret value holds at most ${limits.secretValueBytes} bytes`,
    );
  const secretsAdmin = await secretsAdminOf(client);
  const writer = await E(secretsAdmin).openWriter();
  const box = sealTo(await E(writer).publicKey(), value);
  return E(writer).replace(
    secret,
    box,
    ...(expectedGeneration === undefined ? [] : [expectedGeneration]),
  );
};
harden(writeValue);

/**
 * A bounded JSON answer.
 * @param {Response} response
 */
const boundedJson = async response => {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > ANSWER_BYTES)
    throw Error('answer too large');
  return JSON.parse(text);
};

/**
 * Sign a member in and write its credential.
 * @param {object} options
 * @param {any} options.client a control client on the harness workspace
 * @param {any} options.secret the member's `Secret` presence
 * @param {'claude' | 'codex'} options.provider
 * @param {(authorizationUrl: string) => Promise<string>} options.prompt
 *   shows the URL to the operator and answers the pasted `code#state`
 * @param {string} [options.authorizeUrl]
 * @param {string} [options.tokenUrl]
 * @param {string} [options.redirectUri]
 * @param {string} [options.clientId]
 * @param {readonly string[]} [options.scopes]
 * @param {number} [options.expectedGeneration]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @returns {Promise<{ generation: number }>}
 */
export const signIn = async ({
  client,
  secret,
  provider,
  prompt,
  authorizeUrl,
  tokenUrl,
  redirectUri,
  clientId,
  scopes,
  expectedGeneration,
  fetch = globalThis.fetch,
  now = () => Date.now(),
}) => {
  const defaults = signInDefaults[provider];
  if (defaults === undefined) throw Error('Unknown subscription provider');
  const authorize = authorizeUrl ?? defaults.authorizeUrl;
  const redirect = redirectUri ?? defaults.redirectUri;
  if (authorize === undefined || redirect === undefined)
    throw Error(
      `A ${provider} sign-in needs --authorize-url and --redirect-uri`,
    );
  const oauthClient = clientId ?? defaults.clientId;
  const scopeList = scopes ?? defaults.scopes;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // An independent OAuth state (M4-FIX): the URL is seen by the browser, its
  // history and any proxy, so it never carries the PKCE verifier.
  const state = randomBytes(32).toString('base64url');
  const page = new URL(authorize);
  page.search = new URLSearchParams({
    code: 'true',
    client_id: oauthClient,
    response_type: 'code',
    redirect_uri: redirect,
    scope: scopeList.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Checked on the paste; unrelated to the verifier.
    state,
  }).toString();
  const reply = await prompt(page.href);
  const parts = typeof reply === 'string' ? reply.trim().split('#') : [];
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(parts[0]) ||
    parts[1] !== state
  )
    throw Error('Invalid authorization code or state; start a new sign-in');
  /** @type {any} */
  let token;
  try {
    const response = await fetch(tokenUrl ?? defaults.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: oauthClient,
        code: parts[0],
        state,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`HTTP ${response.status}`);
    }
    token = await boundedJson(response);
  } catch {
    throw Error('Sign-in failed; start a new sign-in');
  }
  const expiresIn = Number(token?.expires_in);
  if (
    typeof token?.access_token !== 'string' ||
    typeof token?.refresh_token !== 'string' ||
    !(expiresIn > 0)
  )
    throw Error('Sign-in failed: the provider answered no usable tokens');
  const accountId =
    provider === 'codex'
      ? (() => {
          const claims = jwtClaims(token.access_token);
          return claims && codexAccountOf(claims);
        })()
      : undefined;
  const value = formatCredential(
    harden({
      provider,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAtMs: now() + expiresIn * 1000,
      ...(accountId === undefined ? {} : { accountId }),
      ...(provider === 'claude'
        ? {
            scopes:
              typeof token.scope === 'string' && token.scope.trim() !== ''
                ? token.scope.trim().split(/ +/)
                : [...scopeList],
          }
        : {}),
    }),
  );
  return writeValue({
    client,
    secret,
    value,
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
  });
};
harden(signIn);

/**
 * Read a value file: UTF-8 text of at most `secretValueBytes` (D-M4-7).
 * @param {string} file
 */
export const readValueFile = async file => {
  const bytes = await readFile(file);
  if (bytes.byteLength > limits.secretValueBytes)
    throw Error(
      `A secret value holds at most ${limits.secretValueBytes} bytes`,
    );
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('This file is not text; secrets hold text');
  }
};
harden(readValueFile);

/**
 * The one Secret with this label.
 * @param {any} client
 * @param {string} label
 */
export const findSecret = async (client, label) => {
  const secret = (await secretsByLabel(await secretsAdminOf(client))).get(
    label,
  );
  if (secret === undefined)
    throw Error(`No single Secret labelled ${JSON.stringify(label)}`);
  return secret;
};
harden(findSecret);

/** @param {string[]} argv */
const parse = argv => {
  /** @type {Record<string, string>} */
  const options = {};
  /** @type {string | undefined} */
  let state;
  const flags = new Set([
    '--secret-label',
    '--value-file',
    '--sign-in',
    '--authorize-url',
    '--token-url',
    '--redirect-uri',
    '--expected-generation',
    '--workspace',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags.has(arg)) {
      i += 1;
      if (argv[i] === undefined) throw Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[i];
    } else if (arg.startsWith('-')) {
      throw Error(`Unknown option ${arg}`);
    } else if (state === undefined) {
      state = arg;
    } else {
      throw Error(`Unexpected argument ${arg}`);
    }
  }
  const usage =
    'usage: subscription-login.mjs STATE --secret-label LABEL (--value-file PATH | --sign-in claude|codex) [--expected-generation N] [--workspace w]';
  if (
    state === undefined ||
    options['secret-label'] === undefined ||
    (options['value-file'] === undefined) === (options['sign-in'] === undefined)
  )
    throw Error(usage);
  return { state, options };
};

const main = async () => {
  const { state, options } = parse(process.argv.slice(2));
  const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
    import('@endo/thixotrope/local-control.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  const client = await connectLocalControl(
    makeNodePowers(),
    path.join(path.resolve(state), 'control.sock'),
    { workspace: options.workspace ?? 'w' },
  );
  try {
    const secret = await findSecret(client, options['secret-label']);
    const expected =
      options['expected-generation'] === undefined
        ? {}
        : { expectedGeneration: Number(options['expected-generation']) };
    /** @type {{ generation: number }} */
    let written;
    if (options['value-file'] !== undefined) {
      const value = await readValueFile(options['value-file']);
      written = await writeValue({ client, secret, value, ...expected });
    } else {
      const provider = /** @type {'claude' | 'codex'} */ (options['sign-in']);
      const lines = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        written = await signIn({
          client,
          secret,
          provider,
          ...(options['authorize-url'] === undefined
            ? {}
            : { authorizeUrl: options['authorize-url'] }),
          ...(options['token-url'] === undefined
            ? {}
            : { tokenUrl: options['token-url'] }),
          ...(options['redirect-uri'] === undefined
            ? {}
            : { redirectUri: options['redirect-uri'] }),
          ...expected,
          prompt: async page => {
            process.stderr.write(`Open this page and sign in:\n${page}\n`);
            return lines.question('Paste the code shown (code#state): ');
          },
        });
      } finally {
        lines.close();
      }
    }
    process.stdout.write(
      `${JSON.stringify({ generation: written.generation })}\n`,
    );
  } finally {
    client.close();
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `subscription-login: ${/** @type {Error} */ (error).message}\n`,
    );
    process.exitCode = 1;
  }
}
