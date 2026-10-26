// @ts-check
/* eslint-disable no-await-in-loop */

import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, stop, restart, makeEndoClient } from '@endo/daemon';
import { E } from '@endo/eventual-send';

import { ensureBook } from '../src/book-client.js';

/** @import {makeBookSession} from '../src/book-session.js' */
/** @typedef {Awaited<ReturnType<typeof makeBookSession>>} Book */

// Exercise actual formula revival, pass-copy durable storage, and introduction
// into an agent guest; no model provider or external network is involved.
test.serial(
  'book formula and agent filesystem survive a daemon restart',
  async t => {
    t.timeout(30_000);
    const root = await mkdtemp(join(tmpdir(), 'whylip-daemon-'));
    const config = {
      statePath: join(root, 'state'),
      ephemeralStatePath: join(root, 'run'),
      cachePath: join(root, 'cache'),
      sockPath: join(root, 'endo.sock'),
      address: '127.0.0.1:0',
    };
    const cancellations = [];
    t.teardown(async () => {
      await stop(config).catch(() => {});
      for (const cancel of cancellations) cancel(Error('test teardown'));
      await rm(root, { recursive: true, force: true });
    });
    const connect = async () => {
      const cancelled = new Promise((_resolve, reject) => {
        cancellations.push(reject);
      });
      cancelled.catch(() => {});
      const client = await makeEndoClient(
        'whylip-test',
        config.sockPath,
        cancelled,
      );
      client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config).catch(async error => {
      await null;
      t.log(
        await readFile(join(config.statePath, 'endo.log'), 'utf8').catch(
          () => 'No daemon log',
        ),
      );
      throw error;
    });
    const host = await connect();
    const profile = await E(host).provideHost('storybook', {
      agentName: 'storybook-agent',
    });
    const fae = await E(profile).provideGuest('fae-handle', {
      agentName: 'fae',
    });
    const caplet = new URL('../src/book-caplet.js', import.meta.url).href;
    const book = await ensureBook(profile, caplet);
    await E(profile).makeUnconfined(
      '@node',
      new URL('./_helper-factory.js', import.meta.url).href,
      harden({ powersName: '@agent', resultName: 'fae-factory' }),
    );
    const agentBook = /** @type {Book} */ (await E(fae).lookup('book'));
    const files = await E(agentBook).getFiles();
    await E(files).write('scene.js', '(function Scene() { return null; })');
    await E(agentBook).patchState(harden({ chapter: 'river' }));
    const event = await E(book).act('choose', harden({ choice: 'river' }));
    await restart(config);
    const revivedHost = await connect();
    const revivedProfile = /** @type {typeof profile} */ (
      await E(revivedHost).lookup('storybook-agent')
    );
    const revivedBook = /** @type {Book} */ (
      await E(revivedProfile).lookup('book')
    );
    const snapshot = await E(revivedBook).getSnapshot();
    t.is(snapshot.source, '(function Scene() { return null; })');
    t.is(snapshot.state.chapter, 'river');
    t.deepEqual(snapshot.pendingEvents, [event]);
    const revivedAgent = /** @type {typeof fae} */ (
      await E(revivedProfile).lookup('fae')
    );
    const reintroduced = /** @type {Book} */ (
      await E(revivedAgent).lookup('book')
    );
    await E(reintroduced).finishEvent(event.id, 'A boat approaches.');
    t.deepEqual((await E(revivedBook).getSnapshot()).activeEventIds, []);
    const job = await E(revivedBook).startTask('Owl', 'Create an SVG owl');
    /** @type {typeof fae | undefined} */
    let helper;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // Wait for the asynchronous launcher to introduce the task capability.
      if (await E(revivedProfile).has('test-last-helper')) {
        const helperName = await E(revivedProfile).lookup('test-last-helper');
        if (typeof helperName !== 'string') throw Error('Invalid helper name');
        helper = /** @type {typeof fae} */ (
          await E(revivedProfile).lookup(helperName)
        );
        if (await E(helper).has('task')) break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!helper) throw Error('Background helper was not provisioned');
    const task = /** @type {Awaited<ReturnType<Book['getTask']>>} */ (
      await E(helper).lookup('task')
    );
    t.is((await E(task).getContext()).id, job.id);
    t.false(
      await E(helper).has('book'),
      'helper receives no live book capability',
    );
    await E(task).write(
      'assets/owl.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    t.deepEqual((await E(revivedBook).getSnapshot()).assets, {});
    await restart(config);
    const continuedHost = await connect();
    const continuedProfile = /** @type {typeof profile} */ (
      await E(continuedHost).lookup('storybook-agent')
    );
    const continuedBook = /** @type {Book} */ (
      await E(continuedProfile).lookup('book')
    );
    const helperProfileName =
      await E(continuedProfile).lookup('test-last-helper');
    if (typeof helperProfileName !== 'string')
      throw Error('Invalid helper name');
    const continuedHelper = /** @type {typeof fae} */ (
      await E(continuedProfile).lookup(helperProfileName)
    );
    const continuedTask = /** @type {Awaited<ReturnType<Book['getTask']>>} */ (
      await E(continuedHelper).lookup('task')
    );
    t.is(
      await E(continuedTask).read('assets/owl.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    await E(continuedTask).complete('Owl ready');
    await E(continuedBook).applyTask(job.id);
    t.truthy((await E(continuedBook).getSnapshot()).assets['assets/owl.svg']);
  },
);
