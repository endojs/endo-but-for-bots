// @ts-check
/**
 * The speech gateway extension (`designs/m11-interfaces.md` sections 1.3,
 * 3.2 and 4; M3's registry, `protocol.js` `GatewayExtension`):
 *
 * - the extras service `speech`: the incarnation's `Speech`
 *   (`AH/speech/host.js`), one host per `GatewayContext`, kept in this
 *   module's `WeakMap`;
 * - the `upgrade` route `/audio` (`AH/speech/route.js`), which receives no
 *   context and reaches the one host of the process through this module;
 * - the `http` route of the capture worklet (`CAPTURE_WORKLET_PATH`), so
 *   CSP `script-src 'self'` admits it;
 * - `Speech.replay` as a `LargeCall` (64 pieces up to `wsMessageBytes`).
 *
 * The context this extension receives carries `readGrant` (D-M11-22):
 * `AH/index.js` lists this module's `gatewayExtension` object in the
 * gateway's `extensionPowers`, and the loader's `require` of this file
 * answers that same object (Node shares the ES module cache, A-5).
 *
 * Synchronous (no top-level await), as M3's loader asks.
 */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CAPTURE_WORKLET_PATH } from '../../speech/audio-protocol.js';
import { makeSpeechHost } from '../../speech/host.js';
import { speechKinds } from '../../speech/kinds.js';
import { makeAudioRoute } from '../../speech/route.js';
import { makeSpeechText } from '../../speech/speech-text.js';
import { openTurnView } from '../../speech/turn-view.js';

/** @import { GatewayContext } from '../protocol.js' */

/** The page's label of the `Speech` service (F.2 d). */
export const SPEECH_LABEL = 'speech';

const workletFile = fileURLToPath(
  new URL('../../speech/capture-worklet.js', import.meta.url),
);

/** @type {WeakMap<GatewayContext, ReturnType<typeof makeSpeechHost>>} */
const hostOf = new WeakMap();
/** @type {ReturnType<typeof makeSpeechHost> | undefined} */
let current;

const pipeline = harden({ openTurnView, makeSpeechText });

/**
 * The host of `context`, made at its first use.
 * @param {GatewayContext} context
 */
const hostFor = context => {
  let host = hostOf.get(context);
  if (host === undefined) {
    host = makeSpeechHost({ context, kinds: speechKinds, pipeline });
    hostOf.set(context, host);
    current = host;
  }
  return host;
};

/** @type {string | undefined} */
let worklet;

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
const serveWorklet = async (request, response) => {
  await null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
    response.end();
    return;
  }
  try {
    worklet ??= await readFile(workletFile, 'utf8');
  } catch {
    response.writeHead(404, { 'Content-Length': '0' });
    response.end();
    return;
  }
  const body = Buffer.from(worklet, 'utf8');
  response.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
};

/** @type {import('../protocol.js').GatewayExtension} */
export const gatewayExtension = harden({
  name: 'speech',
  services: [
    {
      label: SPEECH_LABEL,
      make: context => hostFor(context).speech,
    },
  ],
  routes: [
    makeAudioRoute({ hostNow: () => current }),
    { kind: 'http', path: CAPTURE_WORKLET_PATH, handle: serveWorklet },
  ],
  largeCalls: [
    {
      target: async context => hostFor(context).speech,
      methods: ['replay'],
    },
  ],
});
