// @ts-check
/**
 * Contract test (#290): pin the lal <-> chat runtime protocol surface so a
 * future lal refactor cannot silently rename or drop a tool name or a
 * guest-power method that the chat UI / setup scripts depend on.
 *
 * This is a thin characterization / snapshot test, NOT an end-to-end run.
 * It asserts three frozen sets by inspection of `agent.js`:
 *
 *   1. The LLM-facing tool surface (`toolDefs[].name`) — exactly the tool
 *      names the worker exposes to the model. A rename here changes the
 *      prompt contract and the per-tool `@endo/patterns` validation seam.
 *
 *   2. The guest-power method surface (`E(powers).<method>` in agent.js) —
 *      the daemon-guest methods the worker drives. The chat UI and the
 *      `setup-lal.js` / `setup-llm-provider.js` scripts talk to the SAME
 *      daemon inbox surface (`form` / `submit` / `followMessages` /
 *      `listMessages` / `reply` / `send` / `lookup` / `adopt` / `dismiss`),
 *      so dropping one of these from lal's vocabulary is the failure mode
 *      that breaks the chat-facing inbox flow.
 *
 *   3. The startup `form('@host', 'Add an agent', ...)` emission — the
 *      single message the chat "Add an agent" flow (and setup-lal.js)
 *      consumes. If lal stops emitting it, or renames the label, the chat
 *      setup form never appears.
 *
 * The EXPECTED_* sets below are the load-bearing contract. Bumping them is a
 * deliberate act: a reviewer must confirm the corresponding chat consumer
 * (grep `packages/chat` for the name) was migrated in the same change.
 */

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';

import { toolDefs, make } from '../agent.js';

// ---------------------------------------------------------------------------
// 1. LLM-facing tool surface.
// ---------------------------------------------------------------------------

// The exact tool names lal exposes to the model. Source of truth: the
// `name:` fields of `toolDefs` in agent.js as of #290.
const EXPECTED_TOOL_NAMES = harden([
  'help',
  'has',
  'list',
  'lookup',
  'inspect',
  'readText',
  'writeText',
  'remove',
  'move',
  'copy',
  'makeDirectory',
  'locate',
  'listMessages',
  'resolve',
  'reject',
  'adopt',
  'dismiss',
  'request',
  'send',
  'reply',
  'evaluate',
  'define',
]);

test('lal tool surface: toolDefs exposes exactly the expected tool names', t => {
  const actual = toolDefs.map(d => d.name).sort();
  t.deepEqual(
    actual,
    [...EXPECTED_TOOL_NAMES].sort(),
    'toolDefs tool names drifted; a rename/drop here changes the LLM tool ' +
      'contract. If intentional, update EXPECTED_TOOL_NAMES and confirm any ' +
      'chat-side consumer of the renamed tool was migrated.',
  );
});

test('lal tool surface: every toolDef carries a name, summary, and params matcher', t => {
  for (const def of toolDefs) {
    t.is(typeof def.name, 'string', `tool name must be a string: ${def.name}`);
    t.is(
      typeof def.summary,
      'string',
      `tool "${def.name}" must carry a summary (sent to the model)`,
    );
    t.truthy(
      def.params,
      `tool "${def.name}" must carry a params matcher (the @endo/patterns ` +
        `validation seam that guards E(powers) dispatch)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2 & 3. Guest-power method surface + startup form emission.
//
// A recording stand-in for the daemon guest powers. It logs every method the
// worker invokes and lets `runManager`'s post-form `lookup('host-agent')`
// hang harmlessly so the test observes only the synchronous startup path.
// ---------------------------------------------------------------------------

/**
 * The daemon-guest methods the chat-facing inbox flow depends on lal driving.
 * These are the same method names `packages/chat` and the setup scripts call
 * on the agent/host capability (grep chat for `.form(`, `.submit(`,
 * `followMessages(`, `listMessages(`, `.reply(`). Dropping one here is the
 * silent break the maintainer asked us to lock.
 */
const EXPECTED_CHAT_FACING_METHODS = harden([
  'form', // emits the "Add an agent" setup form chat/setup-lal consume
  'followMessages', // the live inbox stream chat follows
  'listMessages', // pre-scan + chat inbox listing
  'reply', // threaded inbox replies
  'lookup', // resolve host-agent / capabilities
  'locate', // @self locator used by setup scripts' form matching
]);

/**
 * Pump microtasks until `predicate()` is true, up to `maxTurns` turns.
 *
 * The startup contract we assert is synchronous-on-the-microtask-queue: the
 * `form('@host', 'Add an agent', ...)` emission is the FIRST `await` in
 * agent.js's `runManager()`, so it lands within one microtask turn today.
 * Rather than hard-code that turn count (a fixed `await Promise.resolve()`
 * tally that a future `await` inserted ahead of the form emission would
 * silently desync), we poll the recording stub until the form call is
 * observed. The bounded `maxTurns` keeps the wait deterministic and prevents
 * a hang if the emission is dropped entirely — the predicate simply never
 * holds and the caller's assertion fails loudly on the empty recording.
 *
 * @param {() => boolean} predicate
 * @param {number} [maxTurns]
 */
const pumpUntil = async (predicate, maxTurns = 16) => {
  // Leading separator so the loop's await is not the function's first await
  // (@jessie.js/safe-await-separator); also yields one turn before polling.
  await null;
  for (let turn = 0; turn < maxTurns && !predicate(); turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const makeRecordingPowers = () => {
  /** @type {string[]} */
  const calls = [];
  /** @type {Array<{ recipient: unknown, label: unknown, fields: unknown }>} */
  const forms = [];
  // A never-resolving promise so the manager parks at the first await after
  // the form emission (the `lookup('host-agent')`), keeping the test to the
  // synchronous startup contract.
  const hang = makePromiseKit().promise;

  // A recording stand-in for the FarRef<GuestPowers> make() expects; cast at
  // this boundary (as agent.js itself does internally) so the test drives the
  // real startup path without reconstructing the full guest-powers type.
  /** @type {any} */
  const powers = harden({
    form(recipient, label, fields) {
      calls.push('form');
      forms.push({ recipient, label, fields });
      return Promise.resolve();
    },
    lookup(_name) {
      calls.push('lookup');
      return hang;
    },
    locate(_name) {
      calls.push('locate');
      return Promise.resolve('self-locator');
    },
    listMessages() {
      calls.push('listMessages');
      return Promise.resolve(harden([]));
    },
    followMessages() {
      calls.push('followMessages');
      // An async iterable that immediately completes.
      return harden({
        [Symbol.asyncIterator]() {
          return harden({
            next() {
              return Promise.resolve(harden({ value: undefined, done: true }));
            },
          });
        },
      });
    },
    reply() {
      calls.push('reply');
      return Promise.resolve();
    },
  });

  return { powers, calls, forms };
};

test('lal startup emits the "Add an agent" form chat/setup-lal consume', async t => {
  const { powers, forms } = makeRecordingPowers();

  // make() fires runManager() and returns the exo synchronously.
  const exo = make(powers, undefined);
  t.truthy(exo, 'make() returns the Lal exo');

  // Pump microtasks until the startup form is recorded (the manager then
  // parks at the lookup('host-agent') await). Polling, rather than a fixed
  // tick count, keeps the test correct if a future await is inserted ahead
  // of the form emission.
  await pumpUntil(() => forms.length > 0);

  t.is(forms.length, 1, 'lal emits exactly one startup form');
  const [form] = forms;
  t.is(form.recipient, '@host', 'the setup form is sent to @host');
  t.is(
    form.label,
    'Add an agent',
    'the form label is the string the chat "Add an agent" flow keys on',
  );
  const fieldNames = /** @type {Array<{ name: string }>} */ (form.fields).map(
    f => f.name,
  );
  t.deepEqual(
    fieldNames,
    ['name', 'host', 'model', 'authToken'],
    'the setup form fields match what setup-lal.js submits',
  );
});

test('lal startup drives only the expected chat-facing guest-power methods', async t => {
  const { powers, calls } = makeRecordingPowers();
  make(powers, undefined);
  // Pump until the manager emits the form (its first guest-power call), by
  // which point every method it touches before parking at lookup is recorded.
  await pumpUntil(() => calls.includes('form'));

  // Every method the manager touched on the way to the parked lookup must be
  // a member of the expected chat-facing surface. (Subset, not equality:
  // spawnWorkerLoop's per-tool methods are exercised by pi-agent-tools.test.)
  for (const method of calls) {
    t.true(
      [...EXPECTED_CHAT_FACING_METHODS].includes(method),
      `manager invoked unexpected guest-power method "${method}"; if this is ` +
        `a deliberate new dependency, add it to EXPECTED_CHAT_FACING_METHODS ` +
        `and confirm the daemon/chat surface provides it`,
    );
  }
  t.true(calls.includes('form'), 'the manager must emit the setup form');
});
