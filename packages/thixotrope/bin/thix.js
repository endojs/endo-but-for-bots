#!/usr/bin/env node
// @ts-check
import '@endo/init';
import process from 'node:process';
import { join, resolve } from 'node:path';

import { bundleApplication } from '../src/control/bundle-application.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { showInventory } from '../src/inventory/inventory-view.js';
import { showMailbox } from '../src/mail/mailbox-view.js';
import { serveThixotrope } from '../src/control/supervisor.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const platform = makeNodePowers();

const [command, directory = './.thix', ...args] = process.argv.slice(2);
const statePath = resolve(directory);
try {
  if (command === 'serve') {
    const supervisor = await serveThixotrope(platform, statePath);
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
    [
      'clock-grant',
      'alarms',
      'http-grant',
      'http-services',
      'revoke-invite',
      'invite',
      'connect',
      'contacts',
      'send',
      'inbox',
      'outbox',
      'take',
      'discard',
      'mail',
    ].includes(command) ||
    command === 'reachability' ||
    command === 'collect' ||
    command === 'install' ||
    command === 'applications' ||
    command === 'inventory' ||
    command === 'attach' ||
    command === 'status' ||
    command === 'stop'
  ) {
    const client = await connectLocalControl(
      { sockets: platform.sockets, random: platform.random },
      join(statePath, 'control.sock'),
    );
    try {
      if (command === 'clock-grant') {
        console.log(JSON.stringify(await client.call('clockGrant', args[0])));
      } else if (command === 'alarms') {
        console.log(JSON.stringify(await client.call('alarmStatus'), null, 2));
      } else if (command === 'http-grant') {
        const [key, port] = args;
        console.log(
          JSON.stringify(
            await client.call('httpGrant', key, Number(port)),
            null,
            2,
          ),
        );
      } else if (command === 'http-services') {
        console.log(JSON.stringify(await client.call('httpServices'), null, 2));
      } else if (command === 'mail') {
        await showMailbox(platform.terminal.open(), platform.logging, client);
      } else if (
        [
          'revoke-invite',
          'invite',
          'connect',
          'send',
          'take',
          'discard',
          'contacts',
          'inbox',
          'outbox',
        ].includes(command)
      ) {
        const method =
          command === 'revoke-invite'
            ? 'revokeInvitation'
            : command === 'take'
              ? 'takeOffer'
              : command === 'discard'
                ? 'discardOffer'
                : command;
        const result = await client.call(method, ...args);
        console.log(
          command === 'invite' ? result : JSON.stringify(result, null, 2),
        );
      } else if (command === 'install') {
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
        const { bundle } = await bundleApplication(
          platform.bundler,
          modulePath,
        );
        console.log(
          JSON.stringify(
            await client.call('install', name, bundle, grants),
            null,
            2,
          ),
        );
      } else if (command === 'inventory') {
        await showInventory(platform.terminal.open(), client);
      } else if (command === 'attach') {
        const terminal = platform.terminal.open();
        const close = () => {
          terminal.close();
          client.close();
        };
        terminal.onClose(close);
        void client.closed.then(() => terminal.close());
        if (terminal.isTTY) {
          console.log(
            'Workspace JavaScript; retain bindings with globalThis. Ctrl-D detaches.',
          );
          terminal.setPrompt('thix> ');
          terminal.prompt();
        }
        try {
          for await (const source of terminal.lines()) {
            // eslint-disable-next-line no-continue
            if (!source.trim()) continue;
            try {
              console.log(await client.call('evaluate', source));
            } catch (error) {
              console.error(/** @type {Error} */ (error).message);
              if (!terminal.isTTY) process.exitCode = 1;
            }
            if (terminal.isTTY) terminal.prompt();
          }
        } finally {
          terminal.close();
        }
      } else {
        const result = await client.call(command);
        console.log(
          ['status', 'applications', 'reachability', 'collect'].includes(
            command,
          )
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
      'Usage: thix serve|attach|install|applications|inventory|invite|revoke-invite|connect|contacts|send|inbox|outbox|take|discard|mail|clock-grant|alarms|http-grant|http-services|reachability|collect|status|stop [state-directory]',
    );
    process.exitCode = command === undefined || command === 'help' ? 0 : 1;
  }
} catch (error) {
  console.error(/** @type {Error} */ (error).message);
  process.exitCode = 1;
}
