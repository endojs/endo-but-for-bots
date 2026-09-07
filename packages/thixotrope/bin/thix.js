#!/usr/bin/env node
// @ts-check
import '@endo/init';
import process from 'node:process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { bundleApplication } from '../src/bundle-application.js';
import { connectLocalControl } from '../src/local-control.js';
import { showInventory } from '../src/inventory-view.js';
import { serveThixotrope } from '../src/supervisor.js';

const [command, directory = './.thix', ...args] = process.argv.slice(2);
const statePath = resolve(directory);
try {
  if (command === 'serve') {
    const supervisor = await serveThixotrope(statePath);
    const stop = () => {
      void supervisor.close().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(`Thixotrope listening at ${supervisor.socketPath}`);
    try {
      await supervisor.stopped;
      await supervisor.close();
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } else if (
    command === 'install' ||
    command === 'applications' ||
    command === 'inventory' ||
    command === 'attach' ||
    command === 'status' ||
    command === 'stop'
  ) {
    const client = await connectLocalControl(join(statePath, 'control.sock'));
    try {
      if (command === 'install') {
        const [name, modulePath, ...grantArgs] = args;
        if (!name || !modulePath)
          throw Error(
            'Usage: thix install state-directory name module.js [power=inventory-key ...]',
          );
        const grants = grantArgs.map(grant => {
          const separator = grant.indexOf('=');
          if (separator < 1) throw Error('Expected power=inventory-key');
          return [grant.slice(0, separator), grant.slice(separator + 1)];
        });
        const { bundle } = await bundleApplication(modulePath);
        console.log(
          JSON.stringify(
            await client.call('install', name, bundle, grants),
            null,
            2,
          ),
        );
      } else if (command === 'inventory') {
        await showInventory(client);
      } else if (command === 'attach') {
        const terminal = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: Boolean(process.stdin.isTTY),
        });
        const close = () => {
          terminal.close();
          client.close();
        };
        process.once('SIGINT', close);
        terminal.once('SIGINT', close);
        void client.closed.then(() => terminal.close());
        if (process.stdin.isTTY) {
          console.log(
            'Workspace JavaScript; retain bindings with globalThis. Ctrl-D detaches.',
          );
          terminal.setPrompt('thix> ');
          terminal.prompt();
        }
        try {
          for await (const source of terminal) {
            // eslint-disable-next-line no-continue
            if (!source.trim()) continue;
            try {
              console.log(await client.call('evaluate', source));
            } catch (error) {
              console.error(/** @type {Error} */ (error).message);
              if (!process.stdin.isTTY) process.exitCode = 1;
            }
            if (process.stdin.isTTY) terminal.prompt();
          }
        } finally {
          process.removeListener('SIGINT', close);
          terminal.close();
        }
      } else {
        const result = await client.call(command);
        console.log(
          command === 'status' || command === 'applications'
            ? JSON.stringify(result, null, 2)
            : result,
        );
        if (command === 'stop') await client.closed;
      }
    } finally {
      client.close();
    }
  } else {
    console.log(
      'Usage: thix serve|attach|install|applications|inventory|status|stop [state-directory]',
    );
    process.exitCode = command === undefined || command === 'help' ? 0 : 1;
  }
} catch (error) {
  console.error(/** @type {Error} */ (error).message);
  process.exitCode = 1;
}
