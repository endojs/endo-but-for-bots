#!/usr/bin/env node
// @ts-check
/**
 * The operator's gateway script (M3 W3.7; designs/m3-interfaces.md 3.1,
 * 4.3, 8, 17). The admin CLI is M12's; this script covers the gateway only.
 *
 *   node scripts/gateway.mjs serve  STATE --port N [--origin O] [--proxy A]... [--ceiling N]
 *   node scripts/gateway.mjs status STATE
 *   node scripts/gateway.mjs rotate STATE
 *   node scripts/gateway.mjs stop   STATE
 *   node scripts/gateway.mjs url    STATE [--host H]
 *
 * `serve`, `status`, `rotate` and `stop` connect to the supervisor serving
 * STATE (its control socket, workspace `w` unless `--workspace`), reach
 * `AgentHostAdmin.gateway()` and print the answer as one JSON line. `serve`
 * passes the harness's `Operator` (`HarnessRoot.getOperator()`) in the
 * config. None of them carries the sign-in secret: `rotate` answers after
 * the new secret is written, and the value never passes the manager.
 *
 * `url` prints `<origin>/#gateway=<host>&agent=<secret>` (R6-9). The secret
 * is read here, from `<STATE>/agent-host/gateway/signin.enc`, with the
 * secrets wrapping key (`THIX_HARNESS_SECRETS_KEY` or the default location,
 * as the daemon reads it); nothing carries it through the control socket or
 * the hub. The origin and host come from the gateway's status when the
 * daemon answers; `--host H` overrides the host (and, without a daemon,
 * gives the origin: `http://` for a loopback host, else `https://`).
 */
import './_init.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

/**
 * `@endo/far` and the provisioning names, loaded after `_init.mjs` has
 * locked down: a static import would be evaluated before `_init.mjs`'s
 * top-level await finishes (sibling modules do not wait for it), and
 * `@endo/eventual-send` needs `assert` from SES.
 */
const loadDeps = async () => {
  const [{ E }, { names }] = await Promise.all([
    import('@endo/far'),
    import('./provision-steps.js'),
  ]);
  return { E, names };
};

/** The control workspace the templates and provisioning use. */
export const DEFAULT_WORKSPACE = 'w';

const USAGE = [
  'usage: gateway.mjs serve STATE --port N [--origin O] [--proxy A]... [--ceiling N]',
  '       gateway.mjs status|rotate|stop STATE',
  '       gateway.mjs url STATE [--host H]',
  'options: --workspace W (default w)',
].join('\n');

const COMMANDS = new Set(['serve', 'status', 'rotate', 'stop', 'url']);

/**
 * @typedef {object} GatewayArgs
 * @property {'serve' | 'status' | 'rotate' | 'stop' | 'url'} command
 * @property {string} state
 * @property {string} workspace
 * @property {number} [port]
 * @property {string} [origin]
 * @property {string[]} proxies
 * @property {number} [ceiling]
 * @property {string} [host]
 */

/**
 * @param {string} flag
 * @param {string | undefined} value
 */
const wholeNumber = (flag, value) => {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0)
    throw Error(`${flag} takes a whole number\n${USAGE}`);
  return n;
};

/**
 * @param {string[]} argv the arguments after the script
 * @returns {GatewayArgs}
 */
export const parseGatewayArgs = argv => {
  const [command, ...rest] = argv;
  if (command === undefined || !COMMANDS.has(command)) throw Error(USAGE);
  /** @type {Partial<GatewayArgs> & { proxies: string[] }} */
  const options = { proxies: [], workspace: DEFAULT_WORKSPACE };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith('--'))
        throw Error(`${arg} takes a value\n${USAGE}`);
      i += 1;
      return value;
    };
    if (arg === '--port') {
      options.port = wholeNumber(arg, needsValue());
    } else if (arg === '--origin') {
      options.origin = needsValue();
    } else if (arg === '--proxy') {
      options.proxies.push(needsValue());
    } else if (arg === '--ceiling') {
      options.ceiling = wholeNumber(arg, needsValue());
    } else if (arg === '--host') {
      options.host = needsValue();
    } else if (arg === '--workspace') {
      options.workspace = needsValue();
    } else if (arg.startsWith('-')) {
      throw Error(`Unknown option ${arg}\n${USAGE}`);
    } else if (options.state === undefined) {
      options.state = arg;
    } else {
      throw Error(`Unexpected argument ${arg}\n${USAGE}`);
    }
  }
  if (options.state === undefined) throw Error(USAGE);
  if (command === 'serve' && options.port === undefined)
    throw Error(`serve needs --port\n${USAGE}`);
  return /** @type {GatewayArgs} */ ({ ...options, command });
};
harden(parseGatewayArgs);

/**
 * The `GatewayConfig` (without its `Operator`) a `serve` asks for.
 * @param {GatewayArgs} args
 */
export const configOf = args =>
  harden({
    port: /** @type {number} */ (args.port),
    ...(args.origin === undefined ? {} : { publicOrigin: args.origin }),
    ...(args.proxies.length === 0 ? {} : { trustedProxies: args.proxies }),
    ...(args.ceiling === undefined
      ? {}
      : { signInFailuresPerMinute: args.ceiling }),
  });
harden(configOf);

/** @param {string} host */
const isLoopbackHost = host => {
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
};

/**
 * The sign-in URL of a state directory (R6-9), read locally.
 * @param {object} options
 * @param {string} options.state the state directory
 * @param {string} [options.origin] the gateway's origin (from its status)
 * @param {string} [options.host] overrides the origin's host
 * @param {Record<string, string | undefined>} [options.env]
 */
export const gatewayUrl = async ({
  state,
  origin,
  host,
  env = process.env,
}) => {
  const base =
    origin ??
    (host === undefined
      ? undefined
      : `${isLoopbackHost(host) ? 'http' : 'https'}://${host}`);
  if (base === undefined)
    throw Error('the gateway is not serving; give --host to build the URL');
  const hostPart = host ?? new URL(base).host;
  // The secrets store reads guest/lib modules, which need the prelude.
  const { installGuestPrelude } = await import('./guest-prelude.js');
  installGuestPrelude();
  const { makeSignInStore, signInFile } =
    await import('../resources/agent-host/impl/gateway/signin.js');
  // Without the file there is nothing to read; and reading would otherwise
  // create a wrapping key (the store's first use makes one).
  if (!existsSync(signInFile(state)))
    throw Error('no sign-in secret in this state; serve the gateway first');
  const store = makeSignInStore({ stateDir: path.resolve(state), env });
  return `${base}/${await store.fragment(hostPart)}`;
};
harden(gatewayUrl);

/**
 * Open the control client and reach the `GatewayAdmin`.
 * @param {string} state
 * @param {string} workspace
 */
const openAdmin = async (state, workspace) => {
  const { E, names } = await loadDeps();
  const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
    import('@endo/thixotrope/local-control.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  const client = await connectLocalControl(
    makeNodePowers(),
    path.join(path.resolve(state), 'control.sock'),
    { workspace },
  );
  try {
    const admin = await client.call('lookup', names.agentHost);
    if (admin === undefined)
      throw Error(`no ${names.agentHost} in workspace ${workspace}`);
    const gateway = await E(admin).gateway();
    return { client, gateway, E, names };
  } catch (error) {
    client.close();
    throw error;
  }
};

/**
 * Run one command; answers what it prints (a JSON-able value or the URL).
 * @param {GatewayArgs} args
 */
export const runGateway = async args => {
  if (args.command === 'url' && args.host !== undefined) {
    // The status only gives the origin; try it, but a stopped daemon is fine.
    const origin = await openAdmin(args.state, args.workspace)
      .then(async ({ client, gateway, E }) => {
        try {
          const status = await E(gateway).status();
          return status.state === 'serving' ? status.origin : undefined;
        } finally {
          client.close();
        }
      })
      .catch(() => undefined);
    return gatewayUrl({ state: args.state, host: args.host, origin });
  }
  const { client, gateway, E, names } = await openAdmin(
    args.state,
    args.workspace,
  );
  try {
    switch (args.command) {
      case 'serve': {
        const harness = await client.call('lookup', names.harness);
        const operator = await E(harness).getOperator();
        return await E(gateway).serve(harden({ ...configOf(args), operator }));
      }
      case 'status':
        return await E(gateway).status();
      case 'rotate':
        await E(gateway).rotateSignIn();
        return harden({ rotated: true });
      case 'stop':
        await E(gateway).stop();
        return harden({ stopped: true });
      case 'url': {
        const status = await E(gateway).status();
        if (status.state !== 'serving')
          throw Error(
            `the gateway is ${status.state}; give --host to build the URL`,
          );
        return await gatewayUrl({ state: args.state, origin: status.origin });
      }
      default:
        throw Error(USAGE);
    }
  } finally {
    client.close();
  }
};
harden(runGateway);

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  try {
    const answer = await runGateway(parseGatewayArgs(process.argv.slice(2)));
    process.stdout.write(
      `${typeof answer === 'string' ? answer : JSON.stringify(answer)}\n`,
    );
  } catch (error) {
    process.stderr.write(`gateway: ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 1;
  }
}
