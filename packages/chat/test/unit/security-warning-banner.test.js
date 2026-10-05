// @ts-check
import '@endo/init/debug.js';

import test from 'ava';

/** @import { ExecutionContext } from 'ava' */

import { createDOM } from '../helpers/dom-setup.js';
import {
  makeSecurityWarningBanner,
  connectSecurityWarnings,
  SECURITY_WARNING_BANNER_ID,
} from '../../security-warning-banner.js';

/**
 * A fresh happy-dom document, typed as the DOM `Document` the module expects.
 *
 * @param {ExecutionContext} t
 * @returns {Document}
 */
const setupDocument = t => {
  const { document, cleanup } = createDOM();
  t.teardown(cleanup);
  return /** @type {any} */ (document);
};

/** @param {Document} document */
const bannerOf = document =>
  document.getElementById(SECURITY_WARNING_BANNER_ID);

/** @param {Document} document */
const itemsOf = document =>
  [...(bannerOf(document)?.querySelectorAll('li') ?? [])].map(
    li => li.textContent,
  );

/**
 * A stand-in for `window.familiar` that records the subscription the way the
 * preload bridge does.
 */
const makeFakeFamiliar = () => {
  /** @type {Array<(warnings: unknown) => void>} */
  const callbacks = [];
  return {
    familiar: {
      /** @param {(warnings: unknown) => void} callback */
      onSecurityWarnings: callback => {
        callbacks.push(callback);
      },
    },
    /** @param {unknown} warnings */
    emit: warnings => {
      for (const callback of callbacks) callback(warnings);
    },
    callbacks,
  };
};

test.serial('renders each warning as a dismissible alert', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  banner.show(['DNS is leaking.', 'host-resolver-rules flag not set.']);

  const element = bannerOf(document);
  t.truthy(element);
  t.is(element?.getAttribute('role'), 'alert');
  t.is(document.body.firstElementChild, element);
  t.deepEqual(itemsOf(document), [
    'DNS is leaking.',
    'host-resolver-rules flag not set.',
  ]);

  /** @type {any} */ (element).querySelector('button').click();
  t.is(bannerOf(document), null);
});

test.serial('shows nothing for an empty or malformed payload', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);

  banner.show([]);
  t.is(bannerOf(document), null);
  banner.show('not an array');
  t.is(bannerOf(document), null);
  banner.show([42, '', null, 'real', 'real']);
  t.deepEqual(itemsOf(document), ['real']);

  banner.show([]);
  t.is(bannerOf(document), null, 'empty clears it');
});

test.serial('warning text is not interpreted as markup', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  banner.show(['<img src=x onerror=alert(1)>']);

  t.is(bannerOf(document)?.querySelector('img'), null);
  t.deepEqual(itemsOf(document), ['<img src=x onerror=alert(1)>']);
});

test.serial('mount restores the banner after the body is replaced', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  banner.show(['warned']);

  document.body.innerHTML = '<main>app</main>';
  t.is(bannerOf(document), null);
  banner.mount();
  t.deepEqual(itemsOf(document), ['warned']);

  banner.mount();
  t.is(
    document.querySelectorAll(`#${SECURITY_WARNING_BANNER_ID}`).length,
    1,
    'mounting twice does not duplicate',
  );
});

test.serial('a dismissal holds until a new warning arrives', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  banner.show(['first']);
  /** @type {any} */ (bannerOf(document)).querySelector('button').click();

  // The Familiar resends on every page load; the same set stays dismissed.
  banner.show(['first']);
  banner.mount();
  t.is(bannerOf(document), null);

  banner.show(['first', 'second']);
  t.deepEqual(itemsOf(document), ['first', 'second']);
});

test.serial('an empty payload in between does not undo a dismissal', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  banner.show(['first']);
  /** @type {any} */ (bannerOf(document)).querySelector('button').click();

  banner.show([]);
  banner.show(['first']);
  t.is(bannerOf(document), null);
});

test.serial('the banner sits above the reconnect overlay', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  banner.show(['warned']);
  const zIndex = Number(
    /** @type {HTMLElement} */ (bannerOf(document)).style.zIndex,
  );
  // The reconnect overlay in main.js uses z-index 9999.
  t.true(zIndex > 9999);
});

test.serial('connects to the Familiar preload channel', t => {
  const document = setupDocument(t);
  const banner = makeSecurityWarningBanner(document);
  const { familiar, emit, callbacks } = makeFakeFamiliar();

  t.true(connectSecurityWarnings(familiar, banner));
  t.is(callbacks.length, 1);
  emit(['from preload']);
  t.deepEqual(itemsOf(document), ['from preload']);
});

test('does nothing outside the Familiar', t => {
  const shown = [];
  const banner = { show: warnings => shown.push(warnings) };
  t.false(connectSecurityWarnings(undefined, banner));
  t.false(connectSecurityWarnings({ restartDaemon: () => {} }, banner));
  t.deepEqual(shown, []);
});
