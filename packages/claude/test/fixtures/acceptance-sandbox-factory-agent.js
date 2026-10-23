// @ts-check
/// <reference types="ses"/>

import process from 'node:process';
import { spawn } from 'node:child_process';

import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8';

/** @import { Readable } from 'node:stream' */

const passableInterface = name =>
  M.interface(name, {}, { defaultGuards: 'passable' });

/** @param {Readable | null} stream */
const readableToBytesReader = stream =>
  bytesReaderFromIterator(
    (async function* read() {
      if (stream === null) return;
      for await (const chunk of stream) {
        yield chunk instanceof Uint8Array
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : encodeUtf8(String(chunk));
      }
    })(),
  );

/**
 * Test-only unconfined agent that gives the daemon a formula-backed sandbox
 * factory. It maps the sandbox shell's `/work` cwd to the fixture workspace
 * and admits only `node`; production containment is pinned independently by
 * the sandbox-shell engine suite.
 *
 * @param {unknown} _powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (_powers, _context, options = {}) => {
  await null;
  const workspacePath = options.env?.ACCEPTANCE_WORKSPACE;
  if (!workspacePath) {
    throw Error('ACCEPTANCE_WORKSPACE is required');
  }
  return makeExo(
    'AcceptanceSandboxFactory',
    passableInterface('AcceptanceSandboxFactory'),
    {
      listBackends: async () => harden([{ name: 'test', available: true }]),
      make: async () =>
        makeExo(
          'AcceptanceSandboxSlice',
          passableInterface('AcceptanceSandboxSlice'),
          {
            spawn: async (argv, spawnOptions = {}) => {
              if (argv[0] !== 'node' || spawnOptions.cwd !== '/work') {
                throw Error('acceptance sandbox permits node in /work only');
              }
              const child = spawn(process.execPath, argv.slice(1), {
                cwd: workspacePath,
                env: { ...spawnOptions.env },
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              const done = new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', (code, signal) =>
                  resolve(harden({ code, signal })),
                );
              });
              return makeExo(
                'AcceptanceSandboxProcess',
                passableInterface('AcceptanceSandboxProcess'),
                {
                  pid: () => child.pid || 0,
                  stdout: () => readableToBytesReader(child.stdout),
                  stderr: () => readableToBytesReader(child.stderr),
                  wait: () => done,
                  kill: async signal => {
                    child.kill(
                      /** @type {NodeJS.Signals | number | undefined} */ (
                        signal
                      ),
                    );
                  },
                },
              );
            },
            dispose: async () => {},
          },
        ),
    },
  );
};
harden(make);

