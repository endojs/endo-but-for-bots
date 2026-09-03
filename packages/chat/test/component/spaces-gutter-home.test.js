// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import harden from '@endo/harden';
import { Far } from '@endo/pass-style';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { makePromiseKit } from '@endo/promise-kit';
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

const { document: testDocument } = createDOM();

/**
 * Build mock powers that support space 0 config storage and the spaces
 * directory watcher.
 *
 * @param {object} [opts]
 * @param {Map<string, unknown>} [opts.storedValues] - Pre-stored values keyed
 *   by dot-joined path (e.g. "spaces.0").
 * @returns {{
 *   powers: unknown,
 *   calls: Array<{method: string, args: unknown[]}>,
 *   storedValues: Map<string, unknown>,
 * }}
 */
const makeSpacesPowers = ({ storedValues = new Map() } = {}) => {
  /** @type {Array<{method: string, args: unknown[]}>} */
  const calls = [];

  /** @type {string[]} */
  const spaceIds = [];
  for (const key of storedValues.keys()) {
    if (key.startsWith('spaces/')) {
      spaceIds.push(key.slice('spaces/'.length));
    }
  }

  /** @type {Array<(value: { add?: string, remove?: string }) => void>} */
  const nameChangeResolvers = [];

  const spacesDir = Far('SpacesDir', {
    followNameChanges() {
      let initialIndex = 0;
      let pendingKit = null;
      return readerFromIterator(
        Far('NameChangesIterator', {
          async next() {
            if (initialIndex < spaceIds.length) {
              const id = spaceIds[initialIndex];
              initialIndex += 1;
              return { value: { add: id }, done: false };
            }
            if (!pendingKit) {
              pendingKit = makePromiseKit();
              nameChangeResolvers.push(value => {
                if (pendingKit) {
                  pendingKit.resolve(value);
                  pendingKit = null;
                }
              });
            }
            const value = await pendingKit.promise;
            return { value, done: false };
          },
        }),
      );
    },
  });

  const powers = Far('MockPowers', {
    lookup(pathOrFirst, ...rest) {
      let path;
      if (Array.isArray(pathOrFirst)) {
        path = pathOrFirst;
      } else if (typeof pathOrFirst === 'string') {
        path = rest.length > 0 ? [pathOrFirst, ...rest] : [pathOrFirst];
      } else {
        throw new Error(`Invalid path: ${pathOrFirst}`);
      }
      calls.push({ method: 'lookup', args: path });
      const key = path.join('/');
      if (key === 'spaces') {
        return spacesDir;
      }
      if (storedValues.has(key)) {
        return storedValues.get(key);
      }
      throw new Error(`Not found: ${key}`);
    },

    list(name) {
      calls.push({ method: 'list', args: [name] });
      if (name === 'spaces') {
        const ids = [...spaceIds];
        return Far('SpaceIterator', {
          [Symbol.asyncIterator]() {
            let i = 0;
            return Far('SpaceIteratorImpl', {
              async next() {
                if (i < ids.length) {
                  const value = ids[i];
                  i += 1;
                  return { value, done: false };
                }
                return { value: undefined, done: true };
              },
            });
          },
        });
      }
      throw new Error(`Not found: ${name}`);
    },

    makeDirectory(name) {
      calls.push({ method: 'makeDirectory', args: [name] });
      return undefined;
    },

    storeValue(value, petNamePath) {
      const key = petNamePath.join('/');
      calls.push({ method: 'storeValue', args: [value, petNamePath] });
      storedValues.set(key, value);
      const pathParts = petNamePath;
      if (pathParts.length === 2 && pathParts[0] === 'spaces') {
        const id = pathParts[1];
        if (!spaceIds.includes(id)) {
          spaceIds.push(id);
        }
        for (const resolve of nameChangeResolvers) {
          resolve({ add: id });
        }
      }
    },

    remove(dir, name) {
      calls.push({ method: 'remove', args: [dir, name] });
      const key = `${dir}/${name}`;
      storedValues.delete(key);
      const idx = spaceIds.indexOf(name);
      if (idx !== -1) {
        spaceIds.splice(idx, 1);
      }
      for (const resolve of nameChangeResolvers) {
        resolve({ remove: name });
      }
    },
  });

  return { powers, calls, storedValues };
};

/**
 * Helper: create gutter containers and import the component lazily.
 * @param opts
 */
const setupGutter = async (opts = {}) => {
  const $container = /** @type {HTMLElement} */ (
    testDocument.createElement('div')
  );
  $container.id = 'spaces-gutter';
  testDocument.body.appendChild($container);

  const $modalContainer = /** @type {HTMLElement} */ (
    testDocument.createElement('div')
  );
  $modalContainer.id = 'modal-container';
  testDocument.body.appendChild($modalContainer);

  const { powers, calls, storedValues } = makeSpacesPowers(opts);

  // Identify the spaces the watcher will surface from pre-stored config so the
  // wait below covers them, not just the always-present home item: a regular
  // space (id != '0') renders its own item; a stored 'spaces/0' overrides the
  // home icon.
  const regularSpaceIds = [];
  let homeIconOverride;
  for (const [key, value] of storedValues.entries()) {
    if (key.startsWith('spaces/')) {
      const id = key.slice('spaces/'.length);
      if (id === '0') {
        homeIconOverride = /** @type {{ icon?: string }} */ (value)?.icon;
      } else {
        regularSpaceIds.push(id);
      }
    }
  }

  const navigated = [];
  const { createSpacesGutter } = await import('../../spaces-gutter.js');

  const gutter = createSpacesGutter({
    $container,
    $modalContainer,
    powers,
    currentProfilePath: opts.currentProfilePath || [],
    onNavigate: path => navigated.push([...path]),
  });

  // Wait for refresh + watcher to settle: poll for the observable results of the
  // initial refresh (home item, each stored regular space, and any stored home
  // icon override) rather than guessing a fixed delay.
  await waitFor(() => {
    if (!$container.querySelector('.space-item.home')) return false;
    for (const id of regularSpaceIds) {
      if (!$container.querySelector(`.space-item[data-space-id="${id}"]`)) {
        return false;
      }
    }
    if (homeIconOverride !== undefined) {
      const $homeIcon = $container.querySelector(
        '.space-item.home .space-icon',
      );
      if (!$homeIcon || $homeIcon.textContent !== homeIconOverride) {
        return false;
      }
    }
    return true;
  });

  // The edit modals render into their own overlay container, inserted by the
  // gutter immediately after $modalContainer, so the add-space modal's
  // innerHTML re-renders can't detach their confined mounts. (Capture it as the
  // sibling rather than a body-wide query: these serial tests share one body,
  // so a global `.spaces-modal-overlay` query would return an earlier test's.)
  const $editModalContainer = /** @type {HTMLElement} */ (
    $modalContainer.nextElementSibling
  );

  return {
    $container,
    $modalContainer,
    $editModalContainer,
    gutter,
    calls,
    storedValues,
    navigated,
  };
};

// ── Test 1: Right-click space 0 shows Edit but not Delete ──

test.serial('right-click home space shows Edit but not Delete', async t => {
  const { $container } = await setupGutter();

  const $home = $container.querySelector('.space-item.home');
  t.truthy($home, 'home space item exists');

  // Dispatch contextmenu
  const event = new Event('contextmenu', { bubbles: true });
  // @ts-expect-error - setting clientX/Y on generic event
  event.clientX = 50;
  // @ts-expect-error
  event.clientY = 50;
  $home.dispatchEvent(event);

  // The gutter is now confined Preact: the context menu renders on the next
  // async update after the right-click, so poll for it rather than querying
  // synchronously.
  await waitFor(
    () => !!$container.querySelector('.space-context-menu.visible'),
  );
  const $menu = $container.querySelector('.space-context-menu');
  t.truthy($menu, 'context menu exists');
  t.true($menu.classList.contains('visible'), 'context menu is visible');

  const $edit = $menu.querySelector('[data-action="edit"]');
  const $delete = $menu.querySelector('[data-action="delete"]');
  t.truthy($edit, 'edit button exists');
  t.truthy($delete, 'delete button exists');

  // Edit should be visible (data-menu-scope="all")
  t.is($edit.style.display, '', 'edit is visible');
  // Delete should be hidden (data-menu-scope="delible")
  t.is($delete.style.display, 'none', 'delete is hidden for home');
});

// ── setActivePath: navigation that did not come from the gutter ──

// The gutter is built once, outside every space, so it no longer learns the
// current path by being rebuilt with it. This is the seam that replaces that.
test.serial('setActivePath highlights the space at that path', async t => {
  const storedValues = new Map();
  storedValues.set(
    'spaces/1',
    harden({
      id: '1',
      name: 'Work',
      icon: '🧙',
      profilePath: ['work-agent'],
      mode: 'inbox',
      scheme: 'auto',
    }),
  );

  const { $container, gutter } = await setupGutter({ storedValues });
  t.truthy($container.querySelector('.space-item.home.active'));

  gutter.setActivePath(['work-agent']);
  await waitFor(
    () => !!$container.querySelector('.space-item[data-space-id="1"].active'),
  );
  t.falsy($container.querySelector('.space-item.home.active'));

  gutter.setActivePath([]);
  await waitFor(() => !!$container.querySelector('.space-item.home.active'));
  t.falsy($container.querySelector('.space-item[data-space-id="1"].active'));
});

test.serial(
  'setActivePath keeps the open space when two share a path',
  async t => {
    const storedValues = new Map();
    for (const id of ['1', '2']) {
      storedValues.set(
        `spaces/${id}`,
        harden({
          id,
          name: `View ${id}`,
          icon: '🧙',
          profilePath: ['work-agent'],
          mode: 'inbox',
          scheme: 'auto',
        }),
      );
    }

    const { $container, gutter } = await setupGutter({ storedValues });

    gutter.selectSpace('2');
    await waitFor(
      () => !!$container.querySelector('.space-item[data-space-id="2"].active'),
    );

    // The path alone cannot say which of the two is open, so being told about the
    // path the open space already has must leave the highlight where it is —
    // deriving from the path would snap it to whichever space came first.
    gutter.setActivePath(['work-agent']);
    await tick(50);
    t.truthy($container.querySelector('.space-item[data-space-id="2"].active'));
    t.falsy($container.querySelector('.space-item[data-space-id="1"].active'));
  },
);

// ── Test 2: Right-click regular space shows both Edit and Delete ──

test.serial('right-click regular space shows both Edit and Delete', async t => {
  const storedValues = new Map();
  storedValues.set(
    'spaces/1',
    harden({
      id: '1',
      name: 'Work',
      icon: '🧙',
      profilePath: ['work-agent'],
      mode: 'inbox',
      scheme: 'dark',
    }),
  );

  const { $container } = await setupGutter({ storedValues });

  const $space1 = $container.querySelector('.space-item[data-space-id="1"]');
  t.truthy($space1, 'space 1 item exists');

  const event = new Event('contextmenu', { bubbles: true });
  // @ts-expect-error
  event.clientX = 50;
  // @ts-expect-error
  event.clientY = 50;
  $space1.dispatchEvent(event);

  await waitFor(
    () => !!$container.querySelector('.space-context-menu.visible'),
  );
  const $menu = $container.querySelector('.space-context-menu');
  const $edit = $menu.querySelector('[data-action="edit"]');
  const $delete = $menu.querySelector('[data-action="delete"]');

  t.is($edit.style.display, '', 'edit is visible for regular space');
  t.is($delete.style.display, '', 'delete is visible for regular space');
});

// ── Test 3: Edit home space modal omits Name field ──

test.serial(
  'edit home modal omits Name field but has icon and scheme',
  async t => {
    const { $container, $editModalContainer } = await setupGutter();

    // Open context menu on home
    const $home = $container.querySelector('.space-item.home');
    const ctxEvent = new Event('contextmenu', { bubbles: true });
    // @ts-expect-error
    ctxEvent.clientX = 50;
    // @ts-expect-error
    ctxEvent.clientY = 50;
    $home.dispatchEvent(ctxEvent);

    // Click Edit (the confined menu renders on the next async update).
    await waitFor(
      () => !!$container.querySelector('.space-context-menu.visible'),
    );
    const $edit = $container.querySelector('[data-action="edit"]');
    $edit.click();

    await waitFor(() => !!$editModalContainer.querySelector('.icon-selector'));

    // Name field should NOT exist
    const $nameInput = $editModalContainer.querySelector('#edit-space-name');
    t.is($nameInput, null, 'name field is not rendered for home');

    // Icon selector should exist
    const $iconSelector = $editModalContainer.querySelector('.icon-selector');
    t.truthy($iconSelector, 'icon selector exists');

    // Scheme picker slot should exist
    const $schemeSlot = $editModalContainer.querySelector(
      '#scheme-picker-slot',
    );
    t.truthy($schemeSlot, 'scheme picker slot exists');
  },
);

// ── Test 4: Changing icon and scheme of space 0 stores correctly ──

test.serial(
  'changing home icon/scheme stores at spaces.0 with enforced name/path',
  async t => {
    const { $container, $editModalContainer, calls } = await setupGutter();

    // Open context menu on home
    const $home = $container.querySelector('.space-item.home');
    const ctxEvent = new Event('contextmenu', { bubbles: true });
    // @ts-expect-error
    ctxEvent.clientX = 50;
    // @ts-expect-error
    ctxEvent.clientY = 50;
    $home.dispatchEvent(ctxEvent);

    // Click Edit (the confined menu renders on the next async update).
    await waitFor(
      () => !!$container.querySelector('.space-context-menu.visible'),
    );
    const $edit = $container.querySelector('[data-action="edit"]');
    $edit.click();
    await waitFor(
      () => $editModalContainer.querySelectorAll('.icon-option').length > 0,
    );

    // Click a different emoji icon (e.g., the wizard 🧙)
    const $icons = $editModalContainer.querySelectorAll('.icon-option');
    t.true($icons.length > 0, 'icon options rendered');
    // Click the first icon option (🧙)
    $icons[0].click();
    // Poll for the click to commit the selection (the chosen wizard icon gains
    // the `selected` class) before submitting, rather than a fixed delay.
    await waitFor(() =>
      $editModalContainer
        .querySelector('.icon-option.selected')
        ?.textContent.includes('🧙'),
    );

    // Submit the form
    const $form = $editModalContainer.querySelector('.add-space-form');
    t.truthy($form, 'form exists');
    $form.dispatchEvent(new Event('submit', { bubbles: true }));
    await waitFor(() =>
      calls.some(
        c =>
          c.method === 'storeValue' &&
          c.args[1][0] === 'spaces' &&
          c.args[1][1] === '0',
      ),
    );

    // Check that storeValue was called with ['spaces', '1']
    const storeCalls = calls.filter(c => c.method === 'storeValue');
    const homeStoreCall = storeCalls.find(
      c => c.args[1][0] === 'spaces' && c.args[1][1] === '0',
    );
    t.truthy(homeStoreCall, 'storeValue called for spaces.0');

    const storedConfig = homeStoreCall.args[0];
    t.is(storedConfig.name, 'Home', 'name is enforced as Home');
    t.deepEqual(storedConfig.profilePath, [], 'profilePath is enforced as []');
    t.is(storedConfig.icon, '🧙', 'icon was changed');

    // The icon repaints only after the store await resolves and re-render runs,
    // a step after the storeValue call above — poll the rendered icon itself
    // rather than racing that re-render.
    await waitFor(
      () =>
        $container.querySelector('.space-item.home .space-icon')
          ?.textContent === '🧙',
    );
    const $homeIcon = $container.querySelector('.space-item.home .space-icon');
    t.is($homeIcon.textContent, '🧙', 'rendered icon reflects new value');
  },
);

// ── Test 5: Home config loads from stored space 0 on refresh ──

test.serial('home config loads stored icon/scheme from spaces.0', async t => {
  const storedValues = new Map();
  storedValues.set(
    'spaces/0',
    harden({
      id: '0',
      name: 'Ignored',
      icon: '🤖',
      profilePath: ['ignored'],
      mode: 'inbox',
      scheme: 'dark',
    }),
  );

  const { $container } = await setupGutter({ storedValues });

  // Home should use the stored icon
  const $homeIcon = $container.querySelector('.space-item.home .space-icon');
  t.is($homeIcon.textContent, '🤖', 'home icon loaded from space 0');

  // Name should still be Home (not "Ignored")
  const $home = $container.querySelector('.space-item.home');
  t.true(
    $home.getAttribute('title').startsWith('Home'),
    'home name is enforced',
  );
});

// ── Test 6: Edit modal survives the add-space modal's innerHTML render ──

// Regression for the "edit space button broke" report: the add-space modal
// renders by assigning `innerHTML` on $modalContainer, which detached the edit
// modals' confined mounts when they shared that container, leaving a blank
// modal. The edit modals now mount into their own sibling container.
test.serial(
  'edit modal still renders after the add-space modal clobbers its container',
  async t => {
    const { $container, $modalContainer, $editModalContainer } =
      await setupGutter();

    // The edit container must not live inside $modalContainer, or the add-space
    // modal's innerHTML write would detach it.
    t.false(
      $modalContainer.contains($editModalContainer),
      'edit container is not inside the add-space container',
    );

    // Simulate the add-space modal having rendered: it owns $modalContainer and
    // replaces its entire contents via innerHTML.
    $modalContainer.innerHTML = '<div class="add-space-modal">add space</div>';

    // Open the edit modal for the home space (the proven-reliable edit path).
    const $home = $container.querySelector('.space-item.home');
    const ctxEvent = new Event('contextmenu', { bubbles: true });
    // @ts-expect-error
    ctxEvent.clientX = 50;
    // @ts-expect-error
    ctxEvent.clientY = 50;
    $home.dispatchEvent(ctxEvent);

    await waitFor(
      () => !!$container.querySelector('.space-context-menu.visible'),
    );
    const $edit = $container.querySelector('[data-action="edit"]');
    $edit.click();
    await waitFor(() => !!$editModalContainer.querySelector('.add-space-form'));

    // The edit form renders in its own container, untouched by the add-space
    // modal's innerHTML write.
    const $form = $editModalContainer.querySelector('.add-space-form');
    t.truthy(
      $form,
      'edit form rendered after add-space clobbered $modalContainer',
    );
    // And the mount survived the clobber: its host node is still connected.
    t.true(
      $editModalContainer.isConnected,
      'edit container stayed attached to the document',
    );
  },
);

// ── Default space opens first, without a round trip ──
//
// The preference names a space, but opening one needs its profile path and
// mode, which live on the daemon. Waiting for them meant Home was mounted and
// torn down before the default space appeared. The gutter caches the whole
// descriptor beside the preference so the entry point can mount it directly.

test.serial(
  'refresh caches the default space so the next load can open it',
  async t => {
    window.localStorage.clear();
    const storedValues = new Map();
    storedValues.set(
      'spaces/1',
      harden({
        id: '1',
        name: 'Work',
        icon: '🧙',
        profilePath: ['work-agent'],
        mode: 'channel',
        channelPetName: 'general',
        scheme: 'dark',
      }),
    );
    // The preference as a previous session left it: a bare space id.
    window.localStorage.setItem('chat-default-space', '1');
    await setupGutter({ storedValues });

    const { readBootDefaultSpace } = await import('../../spaces-gutter.js');
    const boot = readBootDefaultSpace();
    t.is(boot.id, '1');
    t.deepEqual(boot.profilePath, ['work-agent']);
    t.is(
      boot.spaceInfo.mode,
      'channel',
      'enough to mount it, not just name it',
    );
    t.is(boot.spaceInfo.channelPetName, 'general');
    t.is(boot.scheme, 'dark');
  },
);

test.serial(
  'a default that no longer resolves leaves nothing cached',
  async t => {
    window.localStorage.clear();
    // A preference naming a space that is not in the store: caching it would
    // send the next load somewhere the user cannot actually go.
    window.localStorage.setItem('chat-default-space', '9');
    await setupGutter();

    const { readBootDefaultSpace } = await import('../../spaces-gutter.js');
    t.is(readBootDefaultSpace(), undefined);
  },
);

test.serial(
  'a cached default naming a since-removed space falls back to Home',
  async t => {
    window.localStorage.clear();
    // A cache left by a previous session for a space that no longer exists.
    window.localStorage.setItem(
      'chat-default-space-boot',
      JSON.stringify({
        id: '7',
        profilePath: ['spaces', '7'],
        spaceInfo: { mode: 'channel' },
      }),
    );
    window.localStorage.setItem('chat-default-space', '7');

    // The entry point would have mounted ['spaces','7']; the gutter is created
    // with that path and must notice the space is not there.
    const { navigated } = await setupGutter({
      currentProfilePath: ['spaces', '7'],
    });

    await waitFor(() => navigated.length > 0);
    t.deepEqual(navigated[0], [], 'navigated back to Home');

    const { readBootDefaultSpace } = await import('../../spaces-gutter.js');
    t.is(readBootDefaultSpace(), undefined, 'and dropped the stale cache');
  },
);
