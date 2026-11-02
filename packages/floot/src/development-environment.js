// @ts-check
import { E } from '@endo/eventual-send';
import { makeShellTool } from '@endo/agent-tools/json-tools/shell.js';
import { DEFAULT_WORKLOAD_LIMITS } from '@endo/hosted-agent/workload-limits.js';

export const DEVELOPMENT_PRESET_ID = 'development';
harden(DEVELOPMENT_PRESET_ID);
export const DEVELOPMENT_BACKENDS = harden(['provider', 'fae-codex']);
harden(DEVELOPMENT_BACKENDS);
export const DEVELOPMENT_NETWORK_POLICIES = harden(['off', 'public-internet']);
harden(DEVELOPMENT_NETWORK_POLICIES);
/** @param {string} id */
export const environmentAdminName = id => `floot-environment-admin-${id}`;
harden(environmentAdminName);

/**
 * Keep private admin rooted before publishing only Shell in the model's
 * inventory. A failed/partial publication remains manually inspectable; do
 * not replace its recipe, replay commands, or delete an unknown allocation.
 * @param {{host:any,guest:any,agentName:string,id:string,networkPolicy:string,shellTimeoutMs?:number,shellOutputBytes?:number}} options
 */
export const provideDevelopmentEnvironment = async ({
  host,
  guest,
  agentName,
  id,
  networkPolicy,
  shellTimeoutMs = DEFAULT_WORKLOAD_LIMITS.shellTimeoutMs,
  shellOutputBytes = DEFAULT_WORKLOAD_LIMITS.shellOutputBytes,
}) => {
  if (await E(guest).has('shell')) {
    await lookupEnvironmentAdmin(host, id, { required: true });
    return;
  }
  const adminName = environmentAdminName(id);
  const shellName = `floot-environment-shell-${id}`;
  if (!(await E(host).has(adminName))) {
    if (await E(host).has(shellName))
      throw Error(
        'Development environment publication is incomplete; inspect its retained Shell before retrying',
      );
    const git = await E(guest).lookup('workspace');
    const mount = await E(git).worktree();
    const runner = await E(host).lookup('environment-runner');
    await E(host).provideEnvironment(
      runner,
      mount,
      adminName,
      shellName,
      harden({
        policy: {
          allowedCommands: [
            'sh',
            'bash',
            'curl',
            'git',
            'node',
            'npm',
            'python3',
            'cargo',
            'rustc',
            'rustup',
          ],
          timeoutMs: shellTimeoutMs,
          maxOutputBytes: shellOutputBytes,
        },
        networkPolicy,
      }),
    );
  }
  if (!(await E(host).has(shellName)))
    throw Error(
      'Development environment publication is incomplete; retain its admin for manual cleanup',
    );
  await E(host).copy([shellName], [agentName, 'shell']);
  await E(host).remove(shellName);
};
harden(provideDevelopmentEnvironment);

/**
 * @param {any} host @param {string} id @param {{required?: boolean, checkGuest?: boolean}} [options]
 * @param id
 * @param options
 */
export const lookupEnvironmentAdmin = async (host, id, options = {}) => {
  const name = environmentAdminName(id);
  if (await E(host).has(name)) return E(host).lookup(name);
  let provisioned = options.required;
  const guestName = `session-agent-${id}`;
  if (options.checkGuest && (await E(host).has(guestName))) {
    const guest = await E(host).lookup(guestName);
    provisioned ||= await E(guest).has('shell');
  }
  if (provisioned)
    throw Error(
      'Development environment private admin is missing; cleanup and policy changes cannot be acknowledged',
    );
  return undefined;
};
harden(lookupEnvironmentAdmin);

/**
 * A thin naming/representation adapter over the common Shell tool records.
 * Floot's exec remains JavaScript. No child_process or host-command fallback.
 * @param {any} shell
 */
export const makeDevelopmentTools = shell =>
  new Map(
    makeShellTool(shell).map(record => {
      const name = record.name === 'exec' ? 'runCommand' : 'inspectShell';
      return [
        name,
        harden({
          schema: () =>
            harden({
              type: 'function',
              function: {
                name,
                description: record.description,
                parameters: record.parameters,
              },
            }),
          execute: async args => JSON.stringify(await record.invoke(args)),
          help: () => record.description,
        }),
      ];
    }),
  );
harden(makeDevelopmentTools);
