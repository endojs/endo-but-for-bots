/* global process */

import { makePromiseKit } from '@endo/promise-kit';
import { E } from '@endo/far';
import { whereEndoSock } from '@endo/where';
import { provideEndoClient } from './client.js';
import { isTerminalError } from './doe-normaal.js';
import {
  isErrorPrinted,
  markErrorPrinted,
  printTraceForError,
} from './error-trace.js';
import { parsePetNamePath } from './pet-name.js';

export const withInterrupt = async callback => {
  await null;
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
    process.once(signal, () => cancel(Error(signal)));
  }

  try {
    await callback({ cancel, cancelled });
  } catch (error) {
    if (!isTerminalError(error)) {
      if (!isErrorPrinted(error)) {
        console.error(error);
      }
      cancel(error);
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
      try {
        await callback({
          cancel,
          cancelled,
          bootstrap,
          host,
        });
      } catch (error) {
        // Surface the worker-side stack and worker id via the daemon's
        // trace facility before unwinding any further. The lookup is
        // best-effort: if the trace facet is unavailable or the record
        // is missing, the original error continues to propagate
        // unchanged.
        if (!isTerminalError(error) && !isErrorPrinted(error)) {
          console.error(error);
          markErrorPrinted(error);
          await printTraceForError({ host }, error);
        }
        throw error;
      }
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
