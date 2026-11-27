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
 * - `signIn({ client, secret, provider, ... })`: Claude's
 *   authorization-code flow with PKCE (S256): the authorization URL is
 *   handed to `prompt`, which answers the pasted `code#state`; ChatGPT's
 *   device-code flow (as `codex login --device-auth`): the verification
 *   page and the one-time code are handed to `showDevice`, and the
 *   sign-in finishes once the person approves. Either way the credential
 *   is written in the stored form (`credentials.js`). The provider requests
 *   are `AH/subscriptions/sign-in.js`'s (redirects refused, bounded
 *   answers, time-boxed), the same the browser's "Add account" uses.
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
 *     (--value-file PATH | --sign-in claude|codex) \
 *     [--expected-generation N] [--workspace w]
 */
import './_init.mjs';
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
  signInFlows,
  { names },
  { secretsByLabel },
] = await Promise.all([
  import('@endo/far'),
  // eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
  import('../guest/lib/limits.js'),
  import('../resources/agent-host/impl/secrets/seal.js'),
  import('../resources/agent-host/impl/subscriptions/sign-in.js'),
  import('./provision-steps.js'),
  import('./provision-steps/40-subscriptions.js'),
]);
const {
  claudeAuthorization,
  claudeExchange,
  codexAwaitApproval,
  codexRequestCode,
  parseCodePaste,
  signInLimits,
} = signInFlows;

/** The providers' sign-in constants (`AH/subscriptions/sign-in.js`). */
export const { signInDefaults } = signInFlows;
harden(signInDefaults);
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
 * Sleep `ms`, or less when `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} signal
 */
const sleepUnless = (ms, signal) =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      { once: true },
    );
  });

/**
 * Sign a member in and write its credential.
 * @param {object} options
 * @param {any} options.client a control client on the harness workspace
 * @param {any} options.secret the member's `Secret` presence
 * @param {'claude' | 'codex'} options.provider
 * @param {(authorizationUrl: string) => Promise<string>} [options.prompt]
 *   Claude: shows the URL to the operator and answers the pasted
 *   `code#state`
 * @param {(device: { verificationUrl: string, userCode: string }) => void} [options.showDevice]
 *   ChatGPT: shows the page to open and the one-time code to enter
 * @param {typeof signInDefaults.claude} [options.claudeEndpoints] tests
 * @param {typeof signInDefaults.codex} [options.codexEndpoints] tests
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
  showDevice = () => {},
  claudeEndpoints = signInDefaults.claude,
  codexEndpoints = signInDefaults.codex,
  expectedGeneration,
  fetch = globalThis.fetch,
  now = () => Date.now(),
}) => {
  /** @type {string} */
  let value;
  if (provider === 'claude') {
    if (prompt === undefined) throw Error('A Claude sign-in needs a prompt');
    const {
      url: page,
      state,
      verifier,
    } = claudeAuthorization({
      endpoints: claudeEndpoints,
    });
    const code = parseCodePaste(await prompt(page), state);
    value = await claudeExchange({
      code,
      state,
      verifier,
      fetch,
      now,
      endpoints: claudeEndpoints,
    });
  } else if (provider === 'codex') {
    const signal = AbortSignal.timeout(signInLimits.pendingMs);
    const code = await codexRequestCode({
      fetch,
      now,
      signal,
      endpoints: codexEndpoints,
    });
    showDevice(
      harden({
        verificationUrl: code.verificationUrl,
        userCode: code.userCode,
      }),
    );
    try {
      value = await codexAwaitApproval({
        code,
        fetch,
        now,
        signal,
        sleep: sleepUnless,
        endpoints: codexEndpoints,
      });
    } catch (error) {
      if (signal.aborted)
        throw Error('The code expired after 15 minutes; start again');
      throw error;
    }
  } else {
    throw Error('Unknown subscription provider');
  }
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
          ...expected,
          prompt: async page => {
            process.stderr.write(`Open this page and sign in:\n${page}\n`);
            return lines.question('Paste the code shown (code#state): ');
          },
          showDevice: ({ verificationUrl, userCode }) => {
            process.stderr.write(
              `Open ${verificationUrl} and enter this one-time code (it expires in 15 minutes): ${userCode}\nWaiting for you to approve...\n`,
            );
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
