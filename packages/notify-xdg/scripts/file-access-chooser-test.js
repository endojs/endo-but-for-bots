#!/usr/bin/env node
// @ts-check

/**
 * Manual integration probe for the confined file access chooser wrapper.
 */

import process from 'node:process';
import '@endo/init';

import { E } from '@endo/eventual-send';
import { makeNodeFilesystem } from '@endo/endo-fs';

import { make as makeDBusSock } from '../src/dbus-sock.js';
import { make as makeFileChooser } from '../src/filechooser.js';
import { make as makeFileAccessChooser } from '../src/file-access-chooser.js';

/**
 * @param {{ write: (chunk: string) => unknown }} out
 */
const printHelp = out => {
  out.write(`Usage: ./scripts/file-access-chooser-test.js [--help] [--directory] [--multiple]

Open the XDG desktop portal file chooser through the file-access chooser
adapter and print the returned caps plus a small liveness summary.

Options:
  --directory         Choose directories instead of files
  --multiple          Allow multiple selections
  --title=TEXT        Dialog title override

Environment:
  UID                 Numeric user id for /run/user/<uid>/bus
  FILE_CHOOSER_TITLE  Dialog title
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

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string | undefined}
 */
const getFlagValue = (argv, flag) => {
  const prefix = `${flag}=`;
  const arg = argv.find(entry => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};

const main = async () => {
  const { argv, env, stdout } = process;

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(stdout);
    return 0;
  }

  const chooseDirectories = argv.includes('--directory');
  const multiple = argv.includes('--multiple');
  const title =
    getFlagValue(argv, '--title') ||
    env.FILE_CHOOSER_TITLE ||
    (chooseDirectories ? 'Choose directories' : 'Choose files');
  const uidEnv =
    env.UID ||
    (typeof process.getuid === 'function' ? `${process.getuid()}` : undefined);

  const dbusSock = makeDBusSock(undefined, undefined, {
    env: { ...env, ...(uidEnv ? { UID: uidEnv } : {}) },
  });
  const fileChooser = await makeFileChooser(
    asNameHub({ 'dbus-sock': dbusSock }),
  );
  const rootFilesystem = makeNodeFilesystem({ rootPath: '/' });
  const accessChooser = await makeFileAccessChooser(
    asNameHub({
      'file-chooser': fileChooser,
      'root-filesystem': rootFilesystem,
    }),
  );

  try {
    if (chooseDirectories) {
      const directories = await E(accessChooser).chooseDirectories('', title, {
        multiple,
      });
      const caps = await Promise.all(directories);
      console.log(caps);
      const probes = await Promise.all(
        caps.map(async directory => {
          const cursor = await E(directory).list();
          const entries = await E(cursor).toArray();
          return { entryCount: entries.length };
        }),
      );
      stdout.write(
        `${JSON.stringify(
          {
            kind: 'directories',
            count: caps.length,
            probes,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    const files = await E(accessChooser).chooseFiles('', title, { multiple });
    const caps = await Promise.all(files);
    console.log(caps);
    const probes = await Promise.all(
      caps.map(async file => {
        const stat = await E(file).getStat();
        return { contentLength: Number(stat.size) };
      }),
    );
    stdout.write(
      `${JSON.stringify(
        {
          kind: 'files',
          count: caps.length,
          probes,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } finally {
    await accessChooser.close();
  }
};

main().then(
  code => (process.exitCode = code),
  error => {
    console.error('Error:', error);
    process.exitCode = 1;
  },
);
