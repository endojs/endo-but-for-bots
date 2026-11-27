#!/usr/bin/env node
// @ts-check
/**
 * Provision a served state directory (M1a W1a.6; ownership passes to M12).
 *
 *   node scripts/provision.mjs STATE [--workspace w] [--session-entry FILE]
 *
 * Connects to the supervisor serving STATE (its control socket), creates
 * the workspace if it is missing, and runs `scripts/provision-steps.js`
 * against it. Every step is idempotent: running this again on a
 * provisioned state does nothing. One JSON line per step is printed
 * (`{ name, skipped, ms, detail? }`).
 *
 * Serve the state first (`node scripts/serve.mjs STATE`), under the run
 * lock if anything else may run Ironhorse work.
 */
import './_init.mjs';
import path from 'node:path';
import url from 'node:url';

// Loaded after `_init.mjs` has locked down: a static import would be
// evaluated before `_init.mjs`'s top-level await settles when this file is
// the entry (sibling modules do not wait for it), and `@endo/far` (through
// provision-steps.js) needs `assert` and `HandledPromise` from SES.
const { makeProvision, sessionEntry } = await import('./provision-steps.js');

/** The workspace provisioning uses unless told otherwise (the templates' `w`). */
export const DEFAULT_WORKSPACE = 'w';

/**
 * @param {string} statePath
 * @param {object} [options]
 * @param {string} [options.workspace]
 * @param {string} [options.sessionEntry]
 * @param {(report: import('./provision-steps.js').StepReport) => void} [options.onStep]
 */
export const provisionState = async (
  statePath,
  {
    workspace = DEFAULT_WORKSPACE,
    sessionEntry: entry = sessionEntry,
    onStep,
  } = {},
) => {
  const [{ connectLocalControl }, { makeNodePowers }] = await Promise.all([
    import('@endo/thixotrope/local-control.js'),
    import('@endo/thixotrope/node-powers.js'),
  ]);
  const powers = makeNodePowers();
  const socket = path.join(path.resolve(statePath), 'control.sock');
  /** @param {{ workspace?: string }} [options] */
  const connect = (options = {}) =>
    connectLocalControl(
      powers,
      socket,
      options.workspace === undefined
        ? undefined
        : { workspace: options.workspace },
    );
  const admin = await connect();
  try {
    /** @type {any[]} */
    const workspaces = await admin.call('workspaces');
    const known = workspaces.some(
      w => (typeof w === 'string' ? w : w?.name) === workspace,
    );
    if (!known) await admin.call('createWorkspace', workspace);
  } finally {
    admin.close();
  }
  const client = await connect({ workspace });
  try {
    return await makeProvision({ sessionEntry: entry, onStep })({
      client,
      connect,
    });
  } finally {
    client.close();
  }
};

/** @param {string[]} argv */
const parse = argv => {
  /** @type {{ state?: string, workspace?: string, sessionEntry?: string }} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace') {
      i += 1;
      options.workspace = argv[i];
    } else if (arg === '--session-entry') {
      i += 1;
      options.sessionEntry = path.resolve(argv[i] ?? '');
    } else if (arg.startsWith('-')) {
      throw Error(`Unknown option ${arg}`);
    } else if (options.state === undefined) {
      options.state = arg;
    } else {
      throw Error(`Unexpected argument ${arg}`);
    }
  }
  if (options.state === undefined)
    throw Error(
      'usage: provision.mjs STATE [--workspace w] [--session-entry FILE]',
    );
  return /** @type {{ state: string, workspace?: string, sessionEntry?: string }} */ (
    options
  );
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  try {
    const { state, ...options } = parse(process.argv.slice(2));
    await provisionState(state, {
      ...options,
      onStep: report => process.stdout.write(`${JSON.stringify(report)}\n`),
    });
  } catch (error) {
    process.stderr.write(
      `provision: ${/** @type {Error} */ (error).message}\n`,
    );
    process.exitCode = 1;
  }
}
