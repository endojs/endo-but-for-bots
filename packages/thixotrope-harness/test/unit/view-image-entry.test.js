// @ts-check
// The session's `viewImage` entry (guest/session/tools/view-image.js;
// designs/m8-interfaces.md 6.1, D-M8-11, section 14's vat probes,
// acceptance 14): the argument checks and their texts before any send, an
// unknown label, a stored value refused, the request carrying the bound
// object and the model's raw path text, `imageSeen` on an ok outcome only,
// a failed outcome passed through unchanged, and a retired break from the
// adapter's `ImageTool` left to the turn runner's restart path. The fake
// `ImageTool` is built from the adapter's own `ImageTool` guard.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import {
  viewImageArgumentNames,
  viewImageDescription,
  viewImageTexts,
} from '../../guest/lib/guards/images.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeLabels } from '../../guest/session/labels.js';
import { isRestartSignal } from '../../guest/session/recovery.js';
import {
  makeRuntime,
  requiredParts,
} from '../../guest/session/runtime-parts.js';
import { viewImageEntry } from '../../guest/session/tools/view-image.js';
import { imageGuards } from '../../resources/agent-host/impl/tools/view-image.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const picture = Far('ImageSource', {
  readBase64: () => harden({ data: '', done: true }),
});

/**
 * A StagedText-shaped ok outcome, as the adapter answers it.
 * @type {any}
 */
const okOutcome = harden({
  status: 'ok',
  text: harden({
    blob: Far('Blob', {}),
    bytes: 2048,
    preview: '[Image image/png; bytes retained for model input]',
  }),
});

/**
 * A session context over a real label map and runtime; the `compaction`
 * part is a stand-in that records `imageSeen` (the other required parts
 * are empty stand-ins).
 * @param {object} [options]
 * @param {boolean} [options.withImageSeen]
 */
const sessionOf = ({ withImageSeen = true } = {}) => {
  /** @type {string[]} */
  const seen = [];
  const labels = makeLabels({
    seeds: harden([{ label: 'picture', value: picture, source: 'endowment' }]),
  });
  labels.bindJson('stored', '{"a":1}');
  const compaction = withImageSeen
    ? harden({ imageSeen: (/** @type {string} */ id) => seen.push(id) })
    : harden({});
  const runtime = makeRuntime({
    labels,
    services: harden({}),
    config: harden({}),
    parts: harden(
      requiredParts.map(name => ({
        name,
        make: () => (name === 'compaction' ? compaction : harden({})),
      })),
    ),
  });
  return { context: harden({ runtime }), seen };
};

/**
 * An `ImageTool` built with the adapter's guard: records each request and
 * answers `answer(request)`.
 * @param {(request: any) => any} [answer]
 */
const imageToolOf = (answer = () => okOutcome) => {
  /** @type {any[]} */
  const requests = [];
  const tool = makeExo('ImageTool', imageGuards.ImageTool, {
    view: async (/** @type {any} */ request) => {
      requests.push(request);
      return answer(request);
    },
  });
  const ports = harden({ tools: harden([{ name: 'viewImage', tool }]) });
  return { ports, requests };
};

/**
 * @param {any} args
 * @param {any} ports
 * @param {any} context
 */
const run = (args, ports, context) =>
  viewImageEntry.execute(
    harden({ opId: textOf.opId('t1', 0, 0), args, turnId: 't1' }),
    ports,
    context,
  );

/** @param {string} text */
const failed = text => ({ status: 'failed', text });

test('the entry: adapter site, the contract description, offered only with an ImageTool port', t => {
  t.is(viewImageEntry.name, 'viewImage');
  t.is(viewImageEntry.site, 'adapter');
  t.is(viewImageEntry.describe(), viewImageDescription);
  const schema = JSON.parse(viewImageDescription.parameters);
  t.deepEqual(Object.keys(schema.properties), [...viewImageArgumentNames]);
  t.true(viewImageEntry.available(imageToolOf().ports));
  t.false(viewImageEntry.available(harden({ tools: harden([]) })));
  t.false(viewImageEntry.available(undefined));
  t.false(
    viewImageEntry.available(
      harden({ tools: harden([{ name: 'echo', tool: Far('Echo', {}) }]) }),
    ),
  );
});

test('argument refusals answer their fixed texts before any send', async t => {
  const { ports, requests } = imageToolOf();
  const { context, seen } = sessionOf();
  const staged = harden({
    blob: Far('Blob', {}),
    bytes: 16_710,
    preview: '{"petName":"picture","path":["',
  });
  const tooLarge = await run(staged, ports, context);
  t.deepEqual(
    tooLarge,
    failed(textOf.argumentsTooLarge('viewImage', 16_710, limits.inlineBytes)),
    'staged (over inlineBytes) arguments: a 64 x 255 path',
  );
  t.deepEqual(
    await run('{"petName":"picture","mode":"x"}', ports, context),
    failed(textOf.unexpectedArgument('mode', 'viewImage', ['petName', 'path'])),
    'an unknown key: the R3-26 text with the closed names',
  );
  t.deepEqual(
    await run('{"petName":"picture","path":["a",]}', ports, context),
    failed(
      textOf.argumentsNotJson(
        'unexpected character at position 33, expected a value',
      ),
    ),
  );
  t.deepEqual(
    await run('{"path":["a.png"]}', ports, context),
    failed(textOf.argumentsNotJson('argument "petName" is required')),
  );
  t.deepEqual(
    await run('{"petName":7}', ports, context),
    failed(textOf.argumentsNotJson('argument "petName" must be a string')),
  );
  for (const petName of ['', 'p'.repeat(257), 'p'.repeat(300)]) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await run(JSON.stringify({ petName }), ports, context);
    t.deepEqual(
      outcome,
      failed(viewImageTexts.badPetName),
      petName.length.toString(),
    );
  }
  t.deepEqual(requests, [], 'nothing was sent');
  t.deepEqual(seen, []);
});

test('an unknown label and a stored value are refused without a send', async t => {
  const { ports, requests } = imageToolOf();
  const { context } = sessionOf();
  const unknown = await run('{"petName":"nowhere"}', ports, context);
  t.deepEqual(unknown, failed(textOf.unknownLabel('nowhere')));
  t.deepEqual(
    await run('{"petName":"stored"}', ports, context),
    failed(viewImageTexts.badPetName),
  );
  // A 256-unit name passes the vat's check and then names nothing.
  const long = 'q'.repeat(256);
  t.deepEqual(
    await run(JSON.stringify({ petName: long }), ports, context),
    failed(textOf.unknownLabel(long)),
  );
  t.deepEqual(requests, []);
});

test('the request carries the bound object, the opId and the raw path text', async t => {
  const { ports, requests } = imageToolOf();
  const { context, seen } = sessionOf();
  const plain = await run('{"petName":"picture"}', ports, context);
  t.deepEqual(plain, okOutcome);
  // The path is the model's exact source span: never parsed in the vat,
  // so spacing, escapes and even a non-array reach the adapter as written.
  const raw = '[ "shots" , "m\\u006fbile.png" ]';
  await run(`{"path": ${raw}, "petName":"picture"}`, ports, context);
  await run('{"petName":"picture","path":{"not":"a list"}}', ports, context);
  t.is(requests.length, 3);
  t.deepEqual(Object.keys(requests[0]).sort(), ['opId', 'target']);
  t.is(requests[0].opId, textOf.opId('t1', 0, 0));
  t.is(requests[0].target, picture, 'the object itself, not its label');
  t.is(requests[1].path, raw);
  t.is(requests[2].path, '{"not":"a list"}');
  t.deepEqual(seen, ['t1', 't1', 't1']);
});

test('imageSeen on an ok outcome only; a failed outcome passes through unchanged', async t => {
  /** @type {any} */
  const refusal = harden({
    status: 'failed',
    text: 'Image exceeds the 2 MiB limit; resize it before reading',
  });
  const { ports } = imageToolOf(() => refusal);
  const { context, seen } = sessionOf();
  const passed = await run('{"petName":"picture"}', ports, context);
  t.is(passed, refusal);
  t.deepEqual(seen, []);
  // A runtime whose compaction stand-in has no imageSeen (the stand-in
  // tables of the M5 tests) still answers the outcome.
  const bare = sessionOf({ withImageSeen: false });
  const ok = imageToolOf();
  t.is(await run('{"petName":"picture"}', ok.ports, bare.context), okOutcome);
});

test('a retired break from the ImageTool rejects as a restart signal (adapter site)', async t => {
  const { ports } = imageToolOf(() => {
    throw Error(`ocapn hub: ${RETIRED_TEXT}`);
  });
  const { context, seen } = sessionOf();
  const error = await t.throwsAsync(
    run('{"petName":"picture"}', ports, context),
  );
  // turn.js `onToolError` runs recovery for an adapter-site entry whose
  // rejection is a restart signal, never a failed result.
  t.true(isRestartSignal(error));
  t.is(viewImageEntry.site, 'adapter');
  t.deepEqual(seen, []);
});
