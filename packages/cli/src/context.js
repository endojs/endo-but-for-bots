import { makeCancelKit } from '@endo/cancel';
import { E } from '@endo/eventual-send';
import { whereEndoSock } from '@endo/where';
import { provideEndoClient } from './client.js';
import { isTerminalError } from './doe-normaal.js';
import { parsePetNamePath } from './pet-name.js';

export const withInterrupt = async callback => {
  await null;
  const { cancelled, cancel } = makeCancelKit();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
    process.once(signal, () => cancel(Error(signal)));
  }

  try {
    await callback({ cancel, cancelled });
  } catch (error) {
    if (!isTerminalError(error)) {
      console.error(error);
      cancel(/** @type {Error} */ (error));
      throw error;
    }
    console.log(`\nExiting due to ${/** @type {Error} */ (error)?.message}`);
  }
  cancel(Error('normal termination'));
};

export const withEndoBootstrap = (
  { os, process, clientName = 'cli' },
  callback,
) =>
  withInterrupt(async ({ cancel, cancelled }) => {
    const { username, homedir } = os.userInfo();
    const temp = os.tmpdir();
    const info = {
      user: username,
      home: homedir,
      temp,
    };

    const sockPath = whereEndoSock(process.platform, process.env, info);

    const { getBootstrap } = await provideEndoClient(
      clientName,
      sockPath,
      cancelled,
    );
    const bootstrap = getBootstrap();
    await callback({
      cancel,
      cancelled,
      bootstrap,
    });
  });

export const withEndoHost = ({ os, process }, callback) =>
  withEndoBootstrap(
    { os, process },
    async ({ cancel, cancelled, bootstrap }) => {
      const host = E(bootstrap).host();
      await callback({
        cancel,
        cancelled,
        bootstrap,
        host,
      });
    },
  );

export const withEndoAgent = (agentNamePath, { os, process }, callback) =>
  withEndoHost(
    { os, process },
    async ({ cancel, cancelled, bootstrap, host }) => {
      const agent =
        agentNamePath === undefined
          ? host
          : E(host).lookup(...parsePetNamePath(agentNamePath));
      await callback({
        cancel,
        cancelled,
        bootstrap,
        host,
        agent,
      });
    },
  );

/**
 * Refuse a host-only command for a guest `--as` agent with a clear error,
 * rather than letting the guest's missing method surface raw. A guest holds
 * no identifiers or locators, so it cannot locate, invite, or accept.
 *
 * @param {unknown} agent
 * @param {string} command - How the command reads in the message.
 */
export const assertAgentHoldsLocators = async (agent, command) => {
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (agent)).__getMethodNames__();
  if (!methods.includes('locate')) {
    throw Error(`${command} is not available to a guest agent`);
  }
};
