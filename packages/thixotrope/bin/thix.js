#!/usr/bin/env node
// @ts-check
import '@endo/init';
// The argument vector and exit status are all this entry point takes from
// Node directly; every other host effect goes through `platform`.
import process from 'node:process';

import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makeWorkspaceClient } from '../src/control/workspace-client.js';
import { showAttach } from '../src/tui/attach-view.js';
import { showInventory } from '../src/tui/inventory-view.js';
import { showMailbox } from '../src/tui/mailbox-view.js';
import { printJson, terminalText } from '../src/tui/terminal-text.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const platform = makeNodePowers();
const { logging, paths } = platform;

// `--workspace NAME` (or `--workspace=NAME`) ahead of the command selects
// the workspace a command speaks to; `default` otherwise. The commands that
// are the daemon's rather than a workspace's take no selection.
const argv = process.argv.slice(2);
/** @type {string | undefined} */
let workspace;
/** @type {string | undefined} */
let usageError;
if (argv[0] === '--workspace') {
  [, workspace] = argv.splice(0, 2);
  if (workspace === undefined || workspace.startsWith('-'))
    usageError = 'Usage: thix --workspace NAME command [state-directory ...]';
} else if (argv[0]?.startsWith('--workspace=')) {
  workspace = argv.shift()?.slice('--workspace='.length);
}
const [command, directory = './.thix', ...args] = argv;
const statePath = paths.resolve(directory);
const daemonWide = [
  'workspaces',
  'create-workspace',
  'installations',
  'reachability',
  'collect',
  'stop',
].includes(command);
try {
  if (usageError !== undefined) throw Error(usageError);
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
      'alarms',
      'install-native',
      'revoke-invite',
      'invite',
      'accept',
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
    command === 'installations' ||
    command === 'remove' ||
    command === 'inventory' ||
    command === 'attach' ||
    command === 'status' ||
    command === 'workspaces' ||
    command === 'create-workspace' ||
    command === 'stop'
  ) {
    const client = await connectLocalControl(
      { sockets: platform.sockets, random: platform.random },
      paths.join(statePath, 'control.sock'),
      daemonWide ? {} : { workspace },
    );
    try {
      if (command === 'alarms') {
        logging.log(
          JSON.stringify(await makeWorkspaceClient(client).alarms(), null, 2),
        );
      } else if (command === 'install-native') {
        const [name, resourceDirectory] = args;
        if (!name || !resourceDirectory)
          throw Error(
            'Usage: thix install-native state-directory installation-name resource-directory',
          );
        logging.log(
          JSON.stringify(
            await client.call(
              'installNative',
              name,
              paths.resolve(resourceDirectory),
            ),
            null,
            2,
          ),
        );
      } else if (command === 'mail') {
        await showMailbox(platform.terminal.open(), platform.logging, client);
      } else if (
        [
          'revoke-invite',
          'invite',
          'accept',
          'send',
          'take',
          'discard',
          'contacts',
          'inbox',
          'outbox',
        ].includes(command)
      ) {
        // Mail is the address book's: the client speaks to it, and to the
        // inventory for what a message carries or brought.
        const mail = makeWorkspaceClient(client);
        /** @type {Record<string, (args: string[]) => Promise<unknown>>} */
        const commands = {
          'revoke-invite': ([text]) => mail.revokeInvitation(text),
          invite: ([name]) => mail.invite(name),
          accept: ([name, text]) => mail.accept(name, text),
          send: ([name, text, key]) => mail.send(name, text, key),
          take: ([id, key]) => mail.take(id, key),
          discard: ([id]) => mail.discard(id),
          contacts: () => mail.contacts(),
          inbox: () => mail.inbox(),
          outbox: () => mail.outbox(),
        };
        const result = await commands[command](args);
        // Invitation text is JSON whose escapes survive sanitising; other
        // results carry remote-controlled message text and labels.
        if (command === 'invite') logging.log(terminalText(String(result)));
        else printJson(logging, result);
      } else if (command === 'install') {
        const [name, modulePath, ...grantArgs] = args;
        if (!name || !modulePath)
          throw Error(
            'Usage: thix install state-directory installation-name module.js [power=inventory-key ...]',
          );
        const grants = grantArgs.map(grant => {
          const separator = grant.indexOf('=');
          if (separator < 1) throw Error('Expected power=inventory-key');
          return [grant.slice(0, separator), grant.slice(separator + 1)];
        });
        // Bundled locally; only the guest runs it. The supervisor recomputes
        // the digest at its own boundary rather than trusting this one.
        const { bundle } = await platform.bundler.bundle(modulePath);
        logging.log(
          JSON.stringify(
            await client.call('install', name, bundle, grants),
            null,
            2,
          ),
        );
      } else if (command === 'remove') {
        const [name] = args;
        if (!name)
          throw Error('Usage: thix remove state-directory installation-name');
        logging.log(JSON.stringify(await client.call('remove', name)));
      } else if (command === 'create-workspace') {
        const [name] = args;
        if (!name)
          throw Error(
            'Usage: thix create-workspace state-directory workspace-name',
          );
        logging.log(
          JSON.stringify(await client.call('createWorkspace', name), null, 2),
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
          [
            'status',
            'installations',
            'reachability',
            'collect',
            'workspaces',
          ].includes(command)
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
      'Usage: thix [--workspace NAME | --workspace=NAME] serve|attach|install|install-native|installations|remove|inventory|invite|revoke-invite|accept|contacts|send|inbox|outbox|take|discard|mail|alarms|reachability|collect|status|workspaces|create-workspace|stop [state-directory]',
    );
    process.exitCode = command === undefined || command === 'help' ? 0 : 1;
  }
} catch (error) {
  logging.error(/** @type {Error} */ (error).message);
  process.exitCode = 1;
}
