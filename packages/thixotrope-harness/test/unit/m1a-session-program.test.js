// @ts-check
// The bundled session program (M1a W1a.4; perf row `session.program`):
// within its byte budget, free of the source forms SES refuses to evaluate,
// and runnable from the bundle alone in a compartment that has only the
// guest prelude (what a vat has), through one turn with fakes.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import { guestPrelude } from '../../scripts/guest-prelude.js';
import { harnessRoot } from '../_helpers.js';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const entry = path.join(harnessRoot, 'guest', 'session', 'main.js');

/** Let every pending microtask and eventual send run. */
const drain = () => new Promise(resolve => setImmediate(resolve));

test('the session program bundles within sessionProgramBytes and evaluates with the prelude alone', async t => {
  const bundle = await bundleGuest(entry);
  t.log(
    JSON.stringify({
      metric: 'session.program',
      bytes: bundle.bytes,
      budget: limits.sessionProgramBytes,
      modules: bundle.modules.length,
      ascii: [...bundle.source].every(c => c.charCodeAt(0) < 128),
    }),
  );
  t.true(bundle.bytes <= limits.sessionProgramBytes);
  // SES refuses a source that looks like it holds an import expression or
  // an HTML comment, even inside a comment (JSDoc `import('...')` types).
  t.notRegex(bundle.source, /\bimport\s*(?:\(|\/[/*])/);
  t.notRegex(bundle.source, /<!--|-->/);

  const namespace = new Compartment({
    globals: harden({ ...guestPrelude, TextEncoder }),
    __options__: true,
  }).evaluate(bundle.source);
  t.is(typeof namespace.makeSpareMaker, 'function');
  const maker = namespace.makeSpareMaker();

  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const published = [];
  const ports = harden({
    endpoint: Far('Endpoint', {
      holdTurn: () => new Promise(() => {}),
      releaseTurn: () => {},
      startRound: (/** @type {any} */ req) => rounds.push(req),
      cancelRound: () => {},
    }),
    publisher: Far('LivePublisher', {
      publish: (/** @type {any} */ batch) => published.push(batch),
    }),
    tools: harden([]),
  });
  const { session } = maker.make(
    harden({
      config: harden({
        key: 's1',
        title: 'bundled',
        backendTitle: 'fake',
        modelId: 'scripted',
        preset: harden({ label: 'chat-only' }),
        createdAt: 1,
        userInitiated: true,
      }),
      services: harden({
        backend: Far('Backend', { open: () => ports }),
        host: Far('SessionHostFacet', { liveChannel: () => ports.publisher }),
      }),
      rowReporter: Far('RowReporter', { changed: () => {} }),
    }),
  );
  const turn = await E(session).startTurn(harden({ text: 'hi' }), 2);
  await drain();
  t.is(rounds.length, 1);
  t.true(rounds[0].sink.dispatching(0));
  rounds[0].sink.roundFinal(
    harden({
      round: 0,
      text: 'hello',
      toolCalls: [],
      usage: harden({
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
      }),
      at: 3,
    }),
  );
  const status = await E(turn).whenFinished();
  t.is(status.state, 'completed');
  t.deepEqual(
    published.flatMap(b => b.events.map((/** @type {any} */ e) => e.type)),
    ['turn-start', 'phase', 'final', 'usage', 'end'],
  );
});
