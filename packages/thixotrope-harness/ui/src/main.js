// @ts-check
/**
 * The page's entry (W3.4): lock the realm down, then connect, build the
 * controller and mount the shell. `ui/build.mjs` bundles this file.
 *
 * Sign-in (R6-9, 8): the secret stays in the URL fragment, kept also in
 * `sessionStorage` so a reload of a fragment-less URL in the same tab still
 * signs in; it is sent only inside the WebSocket.
 */
import './pre-lockdown.js';
import '@endo/init';

import {
  GATEWAY_PROTOCOL,
  WS_PATH,
  uiTexts,
} from '../../resources/agent-host/impl/gateway/protocol.js';
import { makeController } from './controller/index.js';
import { features } from './features.js';
import { viewModules } from './feature-list.js';
import { makeConnection } from './net/connection.js';
import { parseLocation, socketUrl } from './net/fragment.js';
import { mount } from './shell/mount.js';

const SIGN_IN_KEY = 'familiar.signIn';
const RELOAD_KEY = 'familiar.protocolReload';

/** @param {'localStorage' | 'sessionStorage'} name */
const storageOf = name => {
  try {
    const storage = /** @type {any} */ (globalThis)[name];
    return storage && typeof storage.getItem === 'function'
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The fragment's sign-in, else the one this tab kept.
 *
 * @param {any} session `sessionStorage` or undefined
 */
const signInOf = session => {
  const parsed = parseLocation(globalThis.location);
  if (!('error' in parsed)) {
    try {
      session?.setItem(SIGN_IN_KEY, JSON.stringify(parsed));
    } catch {
      // blocked storage: the fragment still works
    }
    return parsed;
  }
  if (parsed.error !== 'unconfigured') return parsed;
  try {
    const kept = JSON.parse(session?.getItem(SIGN_IN_KEY) ?? 'null');
    if (
      kept &&
      typeof kept.gateway === 'string' &&
      typeof kept.agent === 'string'
    ) {
      return { gateway: kept.gateway, agent: kept.agent };
    }
  } catch {
    // unreadable: unconfigured
  }
  return parsed;
};

const start = () => {
  const document = globalThis.document;
  const session = storageOf('sessionStorage');
  // A shell from another protocol revision than this bundle: reload once.
  const meta = document.querySelector('meta[name="familiar-protocol"]');
  if (meta && Number(meta.getAttribute('content')) !== GATEWAY_PROTOCOL) {
    if (session?.getItem(RELOAD_KEY) !== String(GATEWAY_PROTOCOL)) {
      session?.setItem(RELOAD_KEY, String(GATEWAY_PROTOCOL));
      globalThis.location.reload();
      return;
    }
  }
  document.title = uiTexts.pageTitle;
  const controller = makeController({
    storage: storageOf('localStorage'),
    locks: globalThis.navigator ? globalThis.navigator.locks : undefined,
    features,
  });
  mount({
    root: document.getElementById('app'),
    controller,
    features,
    views: viewModules,
    window: globalThis,
  });
  const signIn = signInOf(session);
  if ('error' in signIn) {
    controller.setConnection(
      'unconfigured',
      signIn.error === 'query'
        ? uiTexts.queryConfigRefused
        : uiTexts.gatewayNotConfigured,
    );
    return;
  }
  makeConnection({
    url: socketUrl(signIn.gateway, WS_PATH),
    agent: signIn.agent,
    WebSocket: globalThis.WebSocket,
    timers: {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: handle => globalThis.clearTimeout(handle),
    },
    onState: (state, detail) => {
      if (state === 'open') controller.attach(detail?.powers);
      else controller.setConnection(state, detail?.message);
    },
  });
};

start();
