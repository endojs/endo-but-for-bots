// @ts-check
/**
 * M5 acceptance 12 (W5.9; designs/m5-interfaces.md 6, 8.1): from a session
 * vat holding endowments, adopted objects and grants, and from its exec
 * vat, no `PresetCatalog`, `Preset`, `Inventory`, `InventoryEntry`,
 * `Operator`, factory facet, `AgentHostAdmin`, `SecretsAdmin` or secret
 * admin is reachable.
 *
 * `thix reachability` reports holdings by origin vat only, and every M5
 * operator object lives in the factory vat, which a session reaches
 * legitimately (its row reporter and services), so object granularity
 * needs the core request M4 filed (CC-060). As M4's acceptance 5, the check
 * is in two parts:
 *
 * - (a) the interface closure a session vat can reach from what it is made
 *   with (`MakeArgs`, M5's widened `SessionServices` with `endowments`) and
 *   what M5 mints in it (`SessionGrants`, `ToolGrant`, `ExecPowersSource`)
 *   and in its exec vat (`ExecScope` with `inspect`), following every
 *   method's return guard of `interfaces.js`, `interfaces-m5.js` and
 *   `interfaces-m5-factory.js`: none of the forbidden interfaces is in it.
 *   Endowed, adopted and granted objects are whatever the operator chose
 *   (R3-270); their own closure is the operator's authority, not M5's.
 *   Runs in Node, without a daemon.
 * - (b) in a daemon on the m5o template: a session endowed with fixture
 *   objects, holding an adopted attachment and a granted tool, runs a turn
 *   that adopts, calls an endowment through exec `powers` and calls the
 *   granted tool; before and after, `reachability()` shows the session vat
 *   and its exec vats hold no reference into another session vat or any
 *   exec vat of another session, and the turn adds no origin to them. The
 *   fixture objects live in the workspace vat (W5.4's design), so the
 *   workspace vat is an expected origin here (M4's test, with no
 *   endowments, forbids it).
 *
 *   THIX_AGENT=W5.9 corepack yarn test:integration test/integration/m5-reachability.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { interfaces, shapes } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, requestId, waitFor } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  call,
  callRound,
  closing,
  endowedPreset,
  exec,
  fixturesOf,
  objectsTemplate,
  presetSession,
} from './_m5-objects.js';

takeIntegrationLock(test, 'm5 reachability test');

const run = integrationEnabled ? test.serial : test.skip;

/** No session or exec vat may reach these (acceptance 12, section 6). */
const FORBIDDEN = harden([
  'PresetCatalog',
  'Preset',
  'Inventory',
  'InventoryEntry',
  'Operator',
  'SessionFactory',
  'HarnessRoot',
  'AgentHostAdmin',
  'SecretsAdmin',
  'Secret',
  'SecretWriter',
]);

/**
 * Every remotable label a pattern names, anywhere inside it.
 * @param {any} pattern
 * @param {Set<string>} [into]
 */
const labelsIn = (pattern, into = new Set()) => {
  if (pattern === null || typeof pattern !== 'object') return into;
  const tag = pattern[Symbol.toStringTag];
  if (tag === 'match:remotable') {
    const label = pattern.payload?.label;
    if (typeof label === 'string') into.add(label);
    return into;
  }
  if (typeof tag === 'string' && 'payload' in pattern) {
    labelsIn(pattern.payload, into);
    return into;
  }
  for (const value of Object.values(pattern)) labelsIn(value, into);
  return into;
};

/** Interface guards by interface name (every version of a name counts). */
const guardsByName = () => {
  /** @type {Map<string, any[]>} */
  const byName = new Map();
  for (const table of [interfaces, interfaces, interfaces, interfaces]) {
    for (const guard of Object.values(table)) {
      const name = guard.payload.interfaceName;
      byName.set(name, [...(byName.get(name) ?? []), guard]);
    }
  }
  return byName;
};

/**
 * The closure of interfaces reachable through return guards.
 * @param {Iterable<string>} start
 */
const closureFrom = start => {
  const byName = guardsByName();
  const reached = new Set(start);
  const todo = [...reached];
  while (todo.length > 0) {
    const name = /** @type {string} */ (todo.pop());
    for (const guard of byName.get(name) ?? []) {
      for (const method of Object.values(guard.payload.methodGuards)) {
        for (const label of labelsIn(
          /** @type {any} */ (method).payload.returnGuard,
        )) {
          if (!reached.has(label)) {
            reached.add(label);
            todo.push(label);
          }
        }
      }
    }
  }
  return reached;
};

test('acceptance 12 (a): no forbidden interface in the closure from a session or exec vat', t => {
  const start = labelsIn(shapes.MakeArgs);
  t.true(start.has('Backend'));
  t.true(start.has('ExecHandle'));
  // What M5 mints in the session vat and the exec vat.
  for (const name of ['SessionGrants', 'ToolGrant', 'ExecPowersSource'])
    start.add(name);
  start.add('ExecScope');
  const reached = closureFrom(start);
  t.log(`reachable: ${[...reached].sort().join(', ')}`);
  t.deepEqual(
    FORBIDDEN.filter(name => reached.has(name)),
    [],
    'no forbidden interface is reachable',
  );
});

test('the walk finds the M5 operator objects from the Operator (the check can fail)', t => {
  const reached = closureFrom(['Operator']);
  for (const name of ['PresetCatalog', 'Preset', 'Inventory', 'InventoryEntry'])
    t.true(reached.has(name), name);
});

const script = harden({
  turns: [
    {
      input: 'reach',
      rounds: [
        callRound([
          call('adopt', { messageNumber: 1, edgeName: 'calc', petName: 'c' }),
        ]),
        callRound([exec("return E(await E(powers).lookup('notes')).read();")]),
        callRound([call('echo2', { text: 'hi' })]),
        callRound([call('list', {})]),
        closing,
      ],
    },
    { input: 'other', rounds: [closing] },
  ],
});

run(
  'acceptance 12 (b): session and exec vats hold no reference into another session',
  async t => {
    t.timeout(4 * 60_000);
    const t0 = performance.now();
    const template = await objectsTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const fixtures = await fixturesOf(state);
    const made = await slice.makeBackend(script);
    const { backend } = made;

    const preset = await endowedPreset(
      slice,
      { notes: fixtures.notes },
      { label: 'Reach', backend },
    );
    const one = await presetSession(slice, preset, backend, 'reach one');
    const other = await E(slice.factory).createSession(
      harden({
        title: 'reach other',
        preset: slice.chatOnly,
        backend,
        at: Date.now(),
      }),
    );
    const liveOne = await slice.subscribe(one);
    const liveOther = await slice.subscribe(other);
    t.is(
      (await runTurn(slice, other, liveOther, 'other')).end.status,
      'completed',
    );
    const keyOne = (await E(one).getInfo()).key;
    const keyOther = (await E(other).getInfo()).key;

    // A granted tool (the fixture `echo2`), offered from the next round.
    const grant = await E(E(one).grants()).grantTool(fixtures.echoTool);
    const granted = await waitFor(
      async () => {
        const info = await E(grant).describe();
        return info.state === 'pending' ? undefined : info;
      },
      30_000,
      'the grant leaves pending',
      100,
    );
    t.is(granted.state, 'offered');

    const holdings = async () => {
      const report = await state.client.call('reachability');
      /** @type {Map<string, string>} */
      const labelOf = new Map(
        report.workers.map((/** @type {any} */ w) => [
          w.workerId,
          w.debugLabel ?? w.workerId,
        ]),
      );
      /** @type {Map<string, Set<string>>} */
      const out = new Map();
      for (const { holder, target } of report.references) {
        if (labelOf.has(holder))
          out.set(holder, new Set([...(out.get(holder) ?? []), target]));
      }
      return { out, labelOf };
    };

    /**
     * The vat labelled with a session's key (`session <key>`), when the factory
     * made it for that session; a pooled vat keeps its `spare session n` label.
     * @param {Map<string, string>} labelOf
     * @param {string} key
     */
    const sessionVatOf = (labelOf, key) =>
      [...labelOf].find(([, label]) => label === `session ${key}`)?.[0];

    /** @param {string} label */
    const isSessionLabel = label => /(^| )session( |$)/.test(label);
    /** @param {string} label */
    const isExecLabel = label => /(^| )exec( |$)/.test(label);

    const check = async (/** @type {string} */ when) => {
      const { out, labelOf } = await holdings();
      const sessionVats = [...labelOf]
        .filter(([, label]) => isSessionLabel(label))
        .map(([id]) => id);
      let oneVat = sessionVatOf(labelOf, keyOne);
      let otherVat = sessionVatOf(labelOf, keyOther);
      if (oneVat === undefined || otherVat === undefined) {
        // Pooled vats keep their spare label: tell them apart by what they
        // hold (only `one` holds the workspace vat, through its endowment).
        const holdsWorkspace = (/** @type {string} */ id) =>
          [...(out.get(id) ?? [])].some(target =>
            /workspace|^w$/i.test(labelOf.get(target) ?? ''),
          );
        const used = sessionVats.filter(id => (out.get(id)?.size ?? 0) > 0);
        oneVat ??= used.find(holdsWorkspace);
        otherVat ??= used.find(id => id !== oneVat && !holdsWorkspace(id));
      }
      t.truthy(oneVat, `${when}: session one's vat`);
      const execsOf = (/** @type {string | undefined} */ id) =>
        new Set(
          [...(out.get(id ?? '') ?? [])].filter(target =>
            isExecLabel(labelOf.get(target) ?? ''),
          ),
        );
      const oneExecs = execsOf(oneVat);
      const otherExecs = execsOf(otherVat);
      for (const line of [...out].map(
        ([holder, targets]) =>
          `${labelOf.get(holder)} -> ${[...targets].map(x => labelOf.get(x)).join(', ')}`,
      ))
        t.log(`${when}: ${line}`);
      t.deepEqual(
        [...oneExecs].filter(id => otherExecs.has(id)),
        [],
        `${when}: no exec vat is shared by two sessions`,
      );
      const forbidden = new Set([
        ...sessionVats.filter(id => id !== oneVat),
        ...[...labelOf.keys()].filter(
          id => isExecLabel(labelOf.get(id) ?? '') && !oneExecs.has(id),
        ),
      ]);
      const origins = new Set();
      for (const holder of [oneVat, ...oneExecs]) {
        for (const target of out.get(/** @type {string} */ (holder)) ?? []) {
          // Its own exec vats are taken on the first exec call; not an origin.
          if (target !== oneVat && !oneExecs.has(target)) origins.add(target);
          t.false(
            forbidden.has(target),
            `${when}: ${labelOf.get(/** @type {string} */ (holder))} holds into ${labelOf.get(target)}`,
          );
        }
      }
      return { origins, labelOf };
    };

    const before = await check('before');
    // The attachment `calc` (a workspace-vat fixture) through the Composer.
    const from = liveOne.deliveries.length;
    const receipt = await E(slice.composer).submit(
      one,
      'reach',
      requestId(),
      harden({ attachments: [{ label: 'calc', value: fixtures.calc }] }),
    );
    const { turnId } = await E(receipt.turn).getStatus();
    const end = await waitFor(
      () =>
        liveOne.deliveries.find(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= from &&
            (d.event.type === 'end' || d.event.type === 'abort') &&
            d.event.turnId === turnId,
        ),
      90_000,
      'turn reach: end',
      10,
    );
    t.is(end.event.type, 'end');
    const results = (await turnRecords(receipt.turn))
      .filter(r => r.kind === 'tool-result')
      .map(r => [r.result, r.failed]);
    t.log(JSON.stringify(results));
    t.is(results.length, 4);
    t.true(
      results.every(([, failed]) => failed === false),
      'every call ran',
    );
    t.regex(String(results[2][0]), /echo2: hi/);
    t.regex(String(results[3][0]), /"c"/);

    const after = await check('after');
    t.deepEqual(
      [...after.origins]
        .filter(target => !before.origins.has(target))
        .map(id => after.labelOf.get(id)),
      [],
      'the turn adds no origin to the session vat or its exec vat',
    );
    emit({
      metric: 'm5.reachability',
      totalMs: +(performance.now() - t0).toFixed(1),
      origins: [...after.origins].map(id => after.labelOf.get(id)),
      ...(await runIdentity()),
      loadAvg: loadAvg(),
    });
  },
);
