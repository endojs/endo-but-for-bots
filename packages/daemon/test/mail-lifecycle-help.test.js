// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { makeEndoClient, start, stop } from '../index.js';

test.serial(
  'mail help permits inspection and reply while dismissal remains pending',
  async t => {
    t.timeout(45_000);
    const root = await mkdtemp(
      path.join(
        process.platform === 'darwin' ? '/tmp' : tmpdir(),
        'endo-mail-help-',
      ),
    );
    const config = {
      statePath: path.join(root, 'state'),
      ephemeralStatePath: path.join(root, 'run'),
      cachePath: path.join(root, 'cache'),
      sockPath: path.join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      pets: new Map(),
      values: new Map(),
      gcEnabled: false,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
    t.teardown(async () => {
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    await start(config);
    const client = await makeEndoClient(
      'mail-help-test',
      config.sockPath,
      cancelled.promise,
    );
    void client.closed.catch(() => {});
    const host = await E(client.getBootstrap()).host();
    const guest = await E(host).provideGuest('researcher', {
      agentName: 'researcher-agent',
    });
    for (const method of [
      'lookup',
      'list',
      'makeDirectory',
      'remove',
      'evaluate',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const documentation = await E(guest).help(method);
      t.false(documentation.includes('No documentation available'), method);
      t.true(documentation.startsWith(`${method}(`), method);
    }
    t.regex(
      await E(guest).help('evaluate'),
      /retained result does not make a shell child persistent/,
    );
    t.regex(
      await E(guest).help('lookupByLocator'),
      /separately provisioned compatible transport/,
    );
    t.regex(await E(guest).help('readOnly'), /No documentation available/);
    t.regex(await E(guest).help('provideGuest'), /No documentation available/);
    const streamHelp = await E(guest).help('followNameChanges');
    const streamExample = /```js\n([\s\S]*?)```/.exec(streamHelp)?.[1];
    if (!streamExample) throw Error('Missing executable subscription example');
    const readOne = new Compartment({
      __options__: true,
      globals: { E, iterateReader },
    }).evaluate(`(async guest => { ${streamExample} })`);
    t.false((await readOne(guest)).done);
    const changesReader = await E(guest).followNameChanges();
    t.teardown(() => E(changesReader).close());
    const changes = iterateReader(changesReader);
    const initialNames = await E(guest).list();
    for (const name of initialNames) {
      // eslint-disable-next-line no-await-in-loop
      t.like(await changes.next(), { value: { add: name }, done: false });
    }
    const pendingChange = changes.next();
    await E(guest).list(); // A remote turn after the pending stream request.
    await E(changesReader).close();
    t.true((await pendingChange).done);

    await E(guest).storeValue(2, 'operand');
    const locator = await E(guest).locate('operand');
    if (!locator) throw Error('Missing test value locator');
    const directory = await E(guest).makeDirectory('subscription-directory');
    for (const agent of [guest, host, directory]) {
      // eslint-disable-next-line no-await-in-loop
      const reader = await E(agent).followLocatorNameChanges(locator);
      t.teardown(() => E(reader).close());
      const updates = iterateReader(reader);
      // eslint-disable-next-line no-await-in-loop
      t.false((await updates.next()).done);
      const pending = updates.next();
      // eslint-disable-next-line no-await-in-loop
      await E(agent).list();
      // eslint-disable-next-line no-await-in-loop
      await E(reader).close();
      // eslint-disable-next-line no-await-in-loop
      t.true((await pending).done);
    }

    await E(guest).evaluate(
      undefined,
      'operand + 1',
      ['operand'],
      ['operand'],
      'answer',
    );
    t.is(await E(guest).lookup('answer'), 3);
    await E(guest).remove('answer');
    await E(guest).remove('operand');
    await E(guest).remove('subscription-directory');
    t.deepEqual(await E(guest).list(), initialNames);
    const help = await E(guest).help('listMessages');
    t.is(await E(host).help('listMessages'), help);
    t.regex(help, /dismissed is a Promise<void>/);
    t.regex(help, /Never blindly await every field/);
    t.regex(await E(guest).help('followMessages'), /long-lived subscription/);
    t.regex(await E(host).help('reply'), /before dismiss/);
    t.regex(
      await E(guest).help('dismiss'),
      /Reply or resolve\/reject before dismissing/,
    );
    await E(host).send('researcher', ['Research Android integration'], [], []);
    const [task] = await E(guest).listMessages();
    let dismissed = false;
    const dismissal = task.dismissed.then(() => {
      dismissed = true;
    });
    // Execute the actual documented example. Awaiting all fields here would hang.
    const code = /```js\n([\s\S]*?)```/.exec(help)?.[1];
    if (!code) throw Error('Missing executable mailbox inspection example');
    const inspect = new Compartment({
      __options__: true,
      globals: { E },
    }).evaluate(`(async powers => { ${code} })`);
    const summaries = await inspect(guest);
    t.is(summaries[0].messageId, task.messageId);
    t.deepEqual(summaries[0].strings, ['Research Android integration']);
    t.true(summaries[0].done);
    t.false(dismissed); // Content complete does not mean task handled or dismissed.
    await E(guest).reply(task.number, ['Research complete'], [], []);
    t.true(
      (await E(host).listMessages()).some(
        message =>
          message.replyTo === task.messageId &&
          message.strings?.[0] === 'Research complete',
      ),
    );
    t.false(dismissed); // Reply first; dismissal is a separate completion action.
    await E(guest).dismiss(task.number);
    await dismissal;
    t.true(dismissed);
    await t.throwsAsync(E(guest).reply(task.number, ['Too late'], [], []), {
      message: /No such message/,
    });
  },
);
