// @ts-check
// The bundled session program (M1a W1a.4; perf row `session.program`):
// within its byte budget, free of the source forms SES refuses to evaluate,
// and runnable from the bundle alone in a compartment that has only the
// guest prelude (what a vat has), through one turn with fakes.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import path from 'node:path';

import { bundleGuest } from '../../scripts/bundle-guest.mjs';
import {
  programPieceBytes,
  sessionProgramBytes as provisionBudget,
} from '../../scripts/provision-steps.js';
import { guestPrelude } from '../../scripts/guest-prelude.js';
import { harnessRoot } from '../_helpers.js';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeProgramStore } from '../../guest/factory/root.js';
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

/**
 * Owner question G-1 (milestones.md, the group of M6, M8, M9 and M11; the
 * PM's working default until the owner rules): the limit is 270,336
 * bytes. The step-3 tree measured 212,484 bytes (J-10250); the cross-lane
 * seam unit WX.1 added the four lanes' shared guard lines and the part API
 * (233,126 bytes after it, J-1427), counted against the lanes' caps of
 * 9,000 (environments), 9,000 (context window), 32,768 (mail and
 * subagents) and 0 (voice) over the step-3 base. What each lane may still
 * add over the base after WX.1 is in `milestones.md`.
 */
const STEP3_BASE = 212_484;
const WX1_BASE = 233_126;
const laneCaps = harden({
  environments: 9000,
  context: 9000,
  mail: 32_768,
  voice: 0,
});

test('the session program limit holds the step-3 base and the four lanes caps (G-1); every cap agrees', async t => {
  const bundle = await bundleGuest(entry);
  const caps = Object.values(laneCaps).reduce((sum, cap) => sum + cap, 0);
  t.log(
    JSON.stringify({
      metric: 'session.program.base',
      now: bundle.bytes,
      step3Base: STEP3_BASE,
      wx1Base: WX1_BASE,
      laneCaps,
      limit: limits.sessionProgramBytes,
      spare: limits.sessionProgramBytes - STEP3_BASE - caps,
    }),
  );
  t.is(limits.sessionProgramBytes, 270_336);
  t.is(provisionBudget, limits.sessionProgramBytes, 'provisioning agrees');
  t.true(STEP3_BASE + caps <= limits.sessionProgramBytes);
  t.true(WX1_BASE <= STEP3_BASE + caps);
  t.true(bundle.bytes <= limits.sessionProgramBytes);
  // The factory's program store keeps a program of the whole budget.
  const store = makeProgramStore();
  const digest = 'a'.repeat(64);
  const count = Math.ceil(limits.sessionProgramBytes / programPieceBytes);
  let answer;
  for (let index = 0; index < count; index += 1) {
    const size = Math.min(
      programPieceBytes,
      limits.sessionProgramBytes - index * programPieceBytes,
    );
    answer = store.load({ digest, index, count, text: 'p'.repeat(size) });
  }
  t.deepEqual(answer, { complete: true, bytes: limits.sessionProgramBytes });
});
