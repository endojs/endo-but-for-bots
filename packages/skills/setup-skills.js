#!/usr/bin/env node
// @ts-check
/* global process */

// endo-skills-setup <agent-pet-name> [--no-cross-harness]
//
// Mount each conventional skill directory that exists, read-only, under the
// named agent's `agent-skills` pet name. Running this is the user's grant:
// it is the only code that reads skill directories from the filesystem.

import '@endo/init/debug.js';

import os from 'node:os';

import { E } from '@endo/eventual-send';
import { makeEndoClient } from '@endo/daemon';
import { whereEndoSock } from '@endo/where';

import { installSkillMounts, planSkillMounts } from './src/setup.js';

const main = async () => {
  const args = process.argv.slice(2);
  const crossHarness = !args.includes('--no-cross-harness');
  const positional = args.filter(arg => !arg.startsWith('--'));
  if (positional.length !== 1) {
    console.error(
      'usage: endo-skills-setup <agent-pet-name> [--no-cross-harness]',
    );
    process.exitCode = 2;
    return;
  }
  const [agentName] = positional;

  const mounts = await planSkillMounts({
    homeDirectory: os.homedir(),
    workingDirectory: process.cwd(),
    crossHarness,
  });

  const { username, homedir } = os.userInfo();
  const sockPath = whereEndoSock(process.platform, process.env, {
    user: username,
    home: homedir,
    temp: os.tmpdir(),
  });
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  cancelled.catch(() => {});
  const { getBootstrap, closed } = await makeEndoClient(
    'endo-skills-setup',
    sockPath,
    cancelled,
  );
  closed.catch(() => {});
  try {
    const host = await E(await getBootstrap()).host();
    const { removed, added } = await installSkillMounts({
      host,
      agentName,
      mounts,
    });
    for (const entryName of removed) {
      console.log(`removed ${agentName}/agent-skills/${entryName}`);
    }
    for (const { entryName, directory } of mounts) {
      console.log(
        `mounted ${directory} as ${agentName}/agent-skills/${entryName}`,
      );
    }
    if (added.length === 0) {
      console.log('no skill directories found');
    }
  } finally {
    cancel(Error('done'));
  }
};

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
