// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';

import { makeWorkflowEngine, inlineFragments } from '../src/index.js';

const RawInterface = (/** @type {string} */ name) =>
  M.interface(name, {}, { defaultGuards: 'raw' });

/** @param {number} [rounds] */
const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

const makeEngine = async () => {
  const fs = makeInMemoryFilesystem();
  const storeRoot = await E(await E(fs).root()).makeDirectory('store', {});
  let idCounter = 0;
  let tick = 0;
  /** @type {Array<{ kind: string, resolve: (v: unknown) => void }>} */
  const inbox = [];
  const deliver = harden({
    /** @param {unknown} _t @param {any} _p */
    request: (_t, _p) =>
      new Promise(resolve => inbox.push({ kind: 'request', resolve })),
    /** @param {unknown} _t @param {any} _p */
    form: (_t, _p) =>
      new Promise(resolve => inbox.push({ kind: 'form', resolve })),
    /** @param {unknown} _t @param {string} _m @param {unknown[]} _a @param {any} _o */
    call: (_t, _m, _a, _o) =>
      new Promise(resolve => inbox.push({ kind: 'call', resolve })),
    /** @param {unknown} t @param {string} m */
    attenuate: (t, m) => Promise.resolve(`${t}#${m}`),
  });
  const engine = await makeWorkflowEngine({
    storeRoot,
    deliver,
    now: () => {
      tick += 1;
      return tick;
    },
    makeId: () => {
      idCounter += 1;
      return String(idCounter);
    },
    warn: () => {},
  });
  return { engine, inbox };
};

const someCap = makeExo('SomeCap', RawInterface('SomeCap'), {
  ping: () => 'pong',
});

// A form-gated workflow whose reducer copies the reply into context, so
// anything the form participant returns becomes observer-visible via
// status() unless the engine redacts it.
const formGate = harden({
  name: 'form-gate',
  version: 1,
  participants: { approver: { description: 'a' } },
  initial: 'asking',
  states: {
    asking: {
      entry: [
        {
          effect: 'form',
          to: 'approver',
          fields: [{ name: 'decision', label: 'ok?' }],
          as: 'gate',
        },
      ],
      onError: 'failed',
      on: {
        'form.value': {
          when: { as: 'gate' },
          assign:
            '({ context, event }) => ({ ...context, reply: event.values })',
          target: 'done',
        },
      },
    },
    done: { final: 'succeeded' },
    failed: { final: 'failed' },
  },
});

test('a form reply carrying a capability is aliased, not journaled or exposed', async t => {
  const { engine, inbox } = await makeEngine();
  await E(engine.service).define('form-gate', formGate);
  const { observer } = await E(engine.service).start('form-gate', {
    participants: { approver: 'the-approver' },
  });
  await flush();

  const form = inbox.find(entry => entry.kind === 'form');
  t.truthy(form);
  // The malicious reply smuggles a live capability alongside data.
  /** @type {any} */ (form).resolve(
    harden({ decision: 'yes', backdoor: someCap }),
  );
  await flush();

  // The journal is pure data — JSON-serializable, no capability.
  const journal = await E(observer).exportJournal();
  t.notThrows(() => JSON.stringify(journal));
  const serialized = JSON.stringify(journal);
  t.false(serialized.includes('SomeCap'));

  // The observer's context never exposes the raw capability: the whole
  // reply was aliased to a ref string, so `reply` is not a live cap.
  const status = await E(observer).status();
  t.is(typeof status.context.reply, 'string');
  t.regex(/** @type {string} */ (status.context.reply), /^ref:/u);
});

test('a symbol-keyed capability cannot ride into the journal as data', async t => {
  const { engine, inbox } = await makeEngine();
  await E(engine.service).define('form-gate', formGate);
  const { observer } = await E(engine.service).start('form-gate', {
    participants: { approver: 'the-approver' },
  });
  await flush();

  const form = inbox.find(entry => entry.kind === 'form');
  const reply = { decision: 'yes' };
  Object.defineProperty(reply, Symbol.for('smuggle'), {
    value: someCap,
    enumerable: true,
  });
  /** @type {any} */ (form).resolve(harden(reply));
  await flush();

  // The value bears a symbol key, so it is not journalable data: the
  // whole reply is aliased rather than journaled with the symbol
  // silently dropped.
  const status = await E(observer).status();
  t.is(typeof status.context.reply, 'string');
  const journal = await E(observer).exportJournal();
  t.notThrows(() => JSON.stringify(journal));
});

test('fragment inlining rebinds spawn participant references', t => {
  // A fragment declares only a `worker` slot but its entry spawn tries to
  // reach a `secret` reference. Inlining must rebind through the bind
  // interface, so an unbound `secret` throws rather than silently
  // escalating to an outer slot of the same name.
  const escalatingFragment = harden({
    kind: 'fragment',
    name: 'escalate',
    version: 1,
    participants: { worker: { description: 'w' } },
    initial: 'doing',
    states: {
      doing: {
        entry: [
          {
            effect: 'spawn',
            workflow: 'child',
            participants: { stolen: 'secret' },
            as: 'sub',
          },
        ],
        on: { 'child.finished': { when: { as: 'sub' }, target: 'out' } },
      },
      out: { boundary: 'done' },
    },
  });
  const outer = harden({
    name: 'outer',
    version: 1,
    participants: {
      worker: { description: 'w' },
      secret: { description: 'a slot the fragment must not reach' },
    },
    initial: 'gate',
    states: {
      gate: {
        use: {
          fragment: 'escalate',
          bind: { worker: 'worker' },
          on: { done: { target: 'finished' } },
        },
      },
      finished: { final: 'succeeded' },
    },
  });
  t.throws(
    () => inlineFragments(outer, { escalate: escalatingFragment }),
    { message: /references unbound slot "secret"/u },
    'a fragment spawn cannot reach an outer slot it was not bound',
  );
});
