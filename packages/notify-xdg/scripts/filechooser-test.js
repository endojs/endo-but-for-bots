#!/usr/bin/env node
// @ts-check

/**
 * Manual integration probe for the confined file chooser wrapper.
 */

import process from 'node:process';
import '@endo/init';

import { make as makeDBusSock } from '../src/dbus-sock.js';
import { make as makeFileChooser } from '../src/filechooser.js';

/**
 * @param {{ write: (chunk: string) => unknown }} out
 */
const printHelp = out => {
  out.write(`Usage: ./scripts/filechooser-test.js [--help]

Open the XDG desktop portal file chooser and print the response JSON.

Environment:
  UID                 Numeric user id for /run/user/<uid>/bus
  FILE_CHOOSER_TITLE  Dialog title (default: "Choose a file")
`);
};

/**
 * @template {Record<string, unknown>} R
 * @param {R} namedPowers
 */
const asNameHub = namedPowers =>
  harden({
    lookup: name => {
      if (name in namedPowers) {
        return namedPowers[name];
      }
      throw Error(`unknown power: ${name}`);
    },
  });

const main = async () => {
  const { argv, env, stdout } = process;

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(stdout);
    return 0;
  }

  const uidEnv =
    env.UID ||
    (typeof process.getuid === 'function' ? `${process.getuid()}` : undefined);
  const dbusSock = makeDBusSock(undefined, undefined, {
    env: { ...env, ...(uidEnv ? { UID: uidEnv } : {}) },
  });

  const chooser = await makeFileChooser(asNameHub({ 'dbus-sock': dbusSock }));
  const title = env.FILE_CHOOSER_TITLE || 'Choose a file';
  try {
    const result = await chooser.openFile('', title, {});
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.response;
  } finally {
    await chooser.close();
  }
};

main().then(
  code => (process.exitCode = code),
  error => {
    console.error('Error:', error);
    process.exitCode = 1;
  },
);
