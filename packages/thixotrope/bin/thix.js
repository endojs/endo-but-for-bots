#!/usr/bin/env node
// @ts-check
import '@endo/init';
// The argument vector and exit status are all this entry point takes from
// Node directly; every other host effect goes through `platform`.
import process from 'node:process';

import { bundleApplication } from '../src/control/bundle-application.js';
import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { showAttach } from '../src/tui/attach-view.js';
import { showInventory } from '../src/tui/inventory-view.js';
import { showMailbox } from '../src/tui/mailbox-view.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const platform = makeNodePowers();
const { logging, paths } = platform;

const [command, directory = './.thix', ...args] = process.argv.slice(2);
const statePath = paths.resolve(directory);
try {
  if (command === 'serve') {
    const supervisor = await serveThixotrope(platform, statePath);
    const stop = () => {
      void supervisor.close().catch(error => {
        logging.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    logging.log(`Thixotrope listening at ${supervisor.socketPath}`);
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
      paths.join(statePath, 'control.sock'),
    );
    try {
      if (command === 'clock-grant') {
        logging.log(JSON.stringify(await client.call('clockGrant', args[0])));
      } else if (command === 'alarms') {
        logging.log(JSON.stringify(await client.call('alarmStatus'), null, 2));
      } else if (command === 'http-grant') {
        const [key, port] = args;
        logging.log(
          JSON.stringify(
            await client.call('httpGrant', key, Number(port)),
            null,
            2,
          ),
        );
      } else if (command === 'http-services') {
        logging.log(JSON.stringify(await client.call('httpServices'), null, 2));
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
        logging.log(
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
        logging.log(
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
        const failed = await showAttach(terminal, platform.logging, client);
        // A human at a prompt has already seen the error; a piped script
        // needs the process to say so.
        if (failed && !terminal.isTTY) process.exitCode = 1;
      } else {
        const result = await client.call(command);
        logging.log(
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
    logging.log(
      'Usage: thix serve|attach|install|applications|inventory|invite|revoke-invite|connect|contacts|send|inbox|outbox|take|discard|mail|clock-grant|alarms|http-grant|http-services|reachability|collect|status|stop [state-directory]',
    );
    process.exitCode = command === undefined || command === 'help' ? 0 : 1;
  }
} catch (error) {
  logging.error(/** @type {Error} */ (error).message);
  process.exitCode = 1;
}
