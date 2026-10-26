// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { h } from 'preact';

/* eslint-disable import/no-relative-packages */
import { WhylipApp } from '../../../space-whylip/src/App.js';
import { makeBookSession } from '../../../space-whylip/src/book-session.js';
/* eslint-enable import/no-relative-packages */
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

const { document: testDocument, window: testWindow } = createDOM();
const SOURCE = `({h}, {state, update}) => h('section', {key:'book'},
  h('p', {id:'story'}, 'The lantern still shines.'),
  h('button', {id:'explore', onClick:() => update({explored: true})}, state.explored ? 'Explored' : 'Explore'))`;

test.serial(
  'scene errors report once per source revision and explicit repair preserves the book',
  async t => {
    t.timeout(5000);
    /** @type {Map<string, any>} */
    const values = new Map();
    const storage = Far('RepairTestStorage', {
      list: async () => harden([...values.keys()]),
      lookup: async name => values.get(name),
      storeValue: async (value, name) => {
        values.set(name, value);
      },
    });
    const book = await makeBookSession(storage, 'repair-test');
    await E(book).initialize(SOURCE, harden({}));
    /** @type {any[]} */
    const events = [];
    let connections = 0;
    const agent = Far('RepairTestAgent', {
      storeLocator: () => undefined,
      locate: () => 'repair-agent',
    });
    const powers = Far('RepairTestPowers', {
      has: name => {
        connections += 1;
        return name === 'book';
      },
      lookup: name => (name === 'book' ? book : agent),
      locate: () => 'repair-book-locator',
      listMessages: () => harden([]),
      send: (recipient, strings) => {
        events.push(JSON.parse(strings[0].split('\n')[1]));
        return 'sent';
      },
    });
    const parent = testDocument.createElement('div');
    testDocument.body.appendChild(parent);
    t.teardown(() => {
      unmount(parent);
      parent.remove();
    });
    renderConfined(
      h(WhylipApp, {
        powers,
        rootPowers: powers,
        profilePath: [],
        onProfileChange: () => {},
      }),
      parent,
    );
    await waitFor(
      () =>
        parent.querySelector('.whylip-status')?.textContent ===
        'The book is listening',
    );
    const originalStory = parent.querySelector('#story');
    t.truthy(originalStory);
    const files = await E(book).getFiles();
    await E(files).write('scene.js', '({h}');
    const broken = await E(book).getSnapshot();
    await waitFor(() => events.length === 1);
    t.is(events[0].name, 'scene-error');
    t.is(events[0].detail.sourceRevision, broken.sourceRevision);
    t.is(events[0].sourceRevision, broken.sourceRevision);
    t.regex(events[0].detail.message, /./);
    t.is(parent.querySelector('#story'), originalStory);

    const explore = parent.querySelector('#explore');
    if (!(explore instanceof testWindow.HTMLButtonElement))
      throw Error('Missing exploration button');
    explore.click();
    await waitFor(() => explore.textContent === 'Explored');
    await E(book).finishEvent(events[0].id);
    await waitFor(
      () =>
        !parent.querySelector('.whylip-error button')?.hasAttribute('disabled'),
    );
    await tick(50);
    t.is(
      events.length,
      1,
      'local state and event completion do not relaunch automatic repair',
    );

    const repair = parent.querySelector('.whylip-error button');
    if (!(repair instanceof testWindow.HTMLButtonElement))
      throw Error('Missing repair button');
    t.is(repair.textContent, 'Repair scene');
    repair.click();
    await waitFor(() => events.length === 2);
    t.is(events[1].name, 'repair-scene');
    t.is(events[1].detail.sourceRevision, broken.sourceRevision);
    t.is(parent.querySelector('#story'), originalStory);
    t.is(explore.textContent, 'Explored');
    t.is(connections, 1, 'repair never reconnects or resets the book session');

    await E(files).write('scene.js', SOURCE);
    await waitFor(() => parent.querySelector('.whylip-error') === null);
    t.is(parent.querySelector('#story'), originalStory);
    await E(book).finishEvent(events[1].id);
    await E(files).write('scene.js', '({h}');
    await waitFor(() => events.length === 3);
    t.is(events[2].name, 'scene-error');
    t.not(
      events[2].detail.sourceRevision,
      broken.sourceRevision,
      'new source revision can request its own repair',
    );
  },
);
