// @ts-check
import test from '@endo/ses-ava/test.js';
import { createHash } from 'node:crypto';

import { makeIronhorseLimits } from '../src/ironhorse/ironhorse-limits.js';
import { acquireIronhorseRuntime } from '../src/ironhorse/ironhorse-runtime.js';
import {
  bootPaths,
  makeFakeHost,
  manifestPath,
  nativeLocked,
  statePath,
  workerBinary,
} from './_ironhorse-runtime-host.js';

/** @import { ExecutionContext } from 'ava' */

/** @param {string} text */
const sha256 = text => createHash('sha256').update(text).digest('hex');

// What the native worker's identity, profile and manifest were before lock
// helpers could name parts, for the fake host's fixed binary and boot file.
// Existing state directories reopen only while these stay byte-for-byte equal.
const pinnedNativeIdentity =
  '{"format":2,"hostProtocol":"sequenced-hub-outbox-v1","worker":"c21a76a3790fc8178f87a15132fc331a1d824328fa66ef614aa462210e1c952e","bootstrap":["1d624b6ae4e9ce0ce174f872a5d05f6491b0cb388d1ba053f87f902708320a23"]}';
const pinnedNativeProfile =
  '2888f2b7285f01c16e7a2e110817459cbbc8eaac412b38aba94f95abcbeae47b';
const pinnedNativeManifest = `${pinnedNativeIdentity.slice(0, -1)},"limits":{"crankBudget":"10000000","bootstrapBudget":"1000000000","slotCeiling":1000000,"chunkCeiling":268435456}}\n`;

const shell = '/launcher/shell.mjs';
const abi = '/launcher/abi.mjs';
const wasm = '/launcher/module.wasm';
const partFiles = Object.freeze({
  [shell]: 'shell bytes',
  [abi]: 'abi bytes',
  [wasm]: 'module bytes',
});

/**
 * @param {unknown[]} [parts]
 * @param {Record<string, unknown>} [extra]
 */
const wasmLocked = (parts = [shell, abi, wasm], extra = {}) =>
  JSON.stringify({ op: 'locked', heapFormat: 'do-v1', parts, ...extra });

const incompatible = /^Incompatible Ironhorse runtime: worker or bootstrap/;

/**
 * Acquire and immediately release the runtime.
 * @param {ExecutionContext} t
 * @param {ReturnType<typeof makeFakeHost>} host
 */
const acquire = async (t, host) => {
  const runtime = await acquireIronhorseRuntime(host.powers, {
    statePath,
    workerBinary,
    bootPaths: [...bootPaths],
    limits: makeIronhorseLimits({}),
    onLost: () => t.fail('Ironhorse ownership lost unexpectedly'),
  });
  await runtime.release();
  return runtime;
};

/**
 * Expect an acquisition to fail with `message` before the helper is told to
 * prepare, and with ownership released; returns what the attempt did.
 * @param {ExecutionContext} t
 * @param {ReturnType<typeof makeFakeHost>} host
 * @param {RegExp} message
 */
const refused = async (t, host, message) => {
  const before = host.events().length;
  const manifest = host.texts.get(manifestPath);
  await t.throwsAsync(() => acquire(t, host), { message });
  const events = host.events().slice(before);
  t.false(events.includes('prepare'), 'refused before prepare');
  t.is(events.at(-1), 'release', 'ownership released');
  t.is(host.texts.get(manifestPath), manifest, 'manifest untouched');
  return events;
};

test('the native worker keeps its pre-existing identity, profile and manifest', async t => {
  const host = makeFakeHost();
  t.is(sha256(pinnedNativeIdentity), pinnedNativeProfile);
  const runtime = await acquire(t, host);
  t.is(runtime.profile, pinnedNativeProfile);
  const text = host.texts.get(manifestPath);
  t.is(text, pinnedNativeManifest);
  t.false(/heapFormat|parts/.test(text ?? ''));
  const directory = `${statePath}/runtime/${pinnedNativeProfile}`;
  t.is(runtime.workerBinary, `${directory}/0`);
  t.deepEqual(runtime.bootPaths, [`${directory}/1`]);
  t.deepEqual(
    [...host.texts.keys()].filter(path => path.startsWith(`${directory}/`)),
    [`${directory}/0`, `${directory}/1`],
  );
  // Reopening accepts and leaves the manifest as it was.
  const writes = host.events().filter(event => event.startsWith('write'));
  t.is((await acquire(t, host)).profile, pinnedNativeProfile);
  t.deepEqual(
    host.events().filter(event => event.startsWith('write')),
    writes,
  );
});

test('a worker that names parts pins and copies them under their names', async t => {
  const host = makeFakeHost({
    locked: wasmLocked([wasm, shell, abi], { future: 'ignored' }),
    extraFiles: partFiles,
  });
  const runtime = await acquire(t, host);
  // Sorted by basename whatever order the helper listed them in.
  const identity = JSON.stringify({
    ...JSON.parse(pinnedNativeIdentity),
    heapFormat: 'do-v1',
    parts: [
      ['abi.mjs', sha256('abi bytes')],
      ['module.wasm', sha256('module bytes')],
      ['shell.mjs', sha256('shell bytes')],
    ],
  });
  t.is(runtime.profile, sha256(identity));
  t.not(runtime.profile, pinnedNativeProfile);
  const manifest = JSON.parse(host.texts.get(manifestPath) ?? '');
  t.is(
    host.texts.get(manifestPath),
    `${identity.slice(0, -1)},"limits":${JSON.stringify(manifest.limits)}}\n`,
  );
  const directory = `${statePath}/runtime/${runtime.profile}`;
  t.is(runtime.workerBinary, `${directory}/0`);
  t.deepEqual(runtime.bootPaths, [`${directory}/1`]);
  t.is(host.texts.get(`${directory}/0`), 'worker bytes');
  t.is(host.texts.get(`${directory}/1`), 'bootstrap bytes');
  t.is(host.texts.get(`${directory}/shell.mjs`), 'shell bytes');
  t.is(host.texts.get(`${directory}/abi.mjs`), 'abi bytes');
  t.is(host.texts.get(`${directory}/module.wasm`), 'module bytes');
  t.false([...host.texts.keys()].some(path => path.endsWith('.tmp')));

  // The same inputs in another order reopen without rewriting the manifest.
  const writes = host.events().filter(event => event.startsWith('write'));
  host.setLocked(wasmLocked([abi, shell, wasm]));
  t.is((await acquire(t, host)).profile, runtime.profile);
  t.deepEqual(
    host.events().filter(event => event.startsWith('write')),
    writes,
  );
  t.deepEqual(JSON.parse(host.texts.get(manifestPath) ?? ''), manifest);
});

const crossEngine =
  /^Incompatible Ironhorse runtime: the state directory holds "(native|do-v1)" heaps and this worker uses "(native|do-v1)" heaps; use the original worker or migrate to a fresh state directory$/;

test('state written by one engine is refused by the other, before prepare or copy', async t => {
  const native = makeFakeHost({ extraFiles: partFiles });
  await acquire(t, native);
  native.setLocked(wasmLocked());
  const nativeRefusal = await refused(
    t,
    native,
    /holds "native" heaps and this worker uses "do-v1" heaps/,
  );
  t.false(nativeRefusal.some(event => event.startsWith('copy')));
  await t.throwsAsync(() => acquire(t, native), { message: crossEngine });

  const wasmHost = makeFakeHost({
    locked: wasmLocked(),
    extraFiles: partFiles,
  });
  await acquire(t, wasmHost);
  wasmHost.setLocked(nativeLocked);
  const wasmRefusal = await refused(
    t,
    wasmHost,
    /holds "do-v1" heaps and this worker uses "native" heaps/,
  );
  t.false(wasmRefusal.some(event => event.startsWith('copy')));
});

/** @param {string} what */
const partRefusal = what =>
  new RegExp(
    `^Incompatible Ironhorse runtime: ${what}; use the original runtime or migrate to a fresh state directory$`,
  );
const removedPart = (/** @type {string} */ name) =>
  partRefusal(
    `runtime\\.json names worker part "${name}" that this worker does not`,
  );
const addedPart = (/** @type {string} */ name) =>
  partRefusal(`worker part "${name}" is not in runtime\\.json`);
const changedPart = (/** @type {string} */ name) =>
  partRefusal(`worker part "${name}" differs from runtime\\.json`);

test('a changed, removed, added or renamed part is incompatible and named', async t => {
  const host = makeFakeHost({
    locked: wasmLocked(),
    extraFiles: { ...partFiles, '/launcher/extra.mjs': 'extra bytes' },
  });
  await acquire(t, host);
  host.setLocked(wasmLocked([shell, wasm]));
  await refused(t, host, removedPart('abi\\.mjs'));
  host.setLocked(wasmLocked([shell, abi, wasm, '/launcher/extra.mjs']));
  await refused(t, host, addedPart('extra\\.mjs'));
  // A rename is a removal and an addition; saved parts are compared first,
  // so the name runtime.json holds is the one reported, whichever sorts first.
  host.texts.set('/elsewhere/abi2.mjs', 'abi bytes');
  host.setLocked(wasmLocked([shell, '/elsewhere/abi2.mjs', wasm]));
  await refused(t, host, removedPart('abi\\.mjs'));
  host.texts.set('/elsewhere/aaa.mjs', 'abi bytes');
  host.setLocked(wasmLocked([shell, '/elsewhere/aaa.mjs', wasm]));
  await refused(t, host, removedPart('abi\\.mjs'));
  // Moving a part to another directory under the same name is no change.
  host.texts.set('/elsewhere/abi.mjs', 'abi bytes');
  host.setLocked(wasmLocked([shell, '/elsewhere/abi.mjs', wasm]));
  await acquire(t, host);
  // Of two changed parts, the first in runtime.json's order is reported.
  host.texts.set(abi, 'other abi bytes');
  host.texts.set(wasm, 'other module bytes');
  host.setLocked(wasmLocked());
  await refused(t, host, changedPart('abi\\.mjs'));
  host.texts.set(abi, 'abi bytes');
  await refused(t, host, changedPart('module\\.wasm'));
  // A differing worker keeps the generic refusal, even with a part changed.
  host.texts.set(workerBinary, 'other worker bytes');
  await refused(
    t,
    host,
    /^Incompatible Ironhorse runtime: worker or bootstrap differs from runtime\.json; use the original runtime or migrate to a fresh state directory$/,
  );
});

test('saved parts out of order keep the generic refusal', async t => {
  const host = makeFakeHost({ locked: wasmLocked(), extraFiles: partFiles });
  await acquire(t, host);
  const manifest = JSON.parse(host.texts.get(manifestPath) ?? '');
  host.texts.set(
    manifestPath,
    JSON.stringify({ ...manifest, parts: [...manifest.parts].reverse() }),
  );
  await refused(t, host, incompatible);
});

test('a part that changes while being copied is refused and its copy removed', async t => {
  const host = makeFakeHost({
    locked: wasmLocked(),
    extraFiles: partFiles,
    onCopy: (_from, to) => {
      if (to.endsWith('/module.wasm.tmp')) host.texts.set(to, 'tampered');
    },
  });
  const events = await refused(
    t,
    host,
    /^Ironhorse runtime changed while being copied$/,
  );
  t.true(events.some(event => event.endsWith('/module.wasm.tmp')));
  t.false([...host.texts.keys()].some(path => path.endsWith('.tmp')));
  t.false(
    [...host.texts.keys()].some(
      path =>
        path.startsWith(`${statePath}/runtime/`) &&
        path.endsWith('/module.wasm'),
    ),
  );
});

const tooMany = Array.from({ length: 17 }, (_, index) => `/p/part${index}`);

test('a malformed locked message is refused before anything is hashed', async t => {
  await null;
  for (const [line, message] of /** @type {[string, RegExp][]} */ ([
    ['null', /^Invalid ownership protocol$/],
    ['{"op":"locked","heapFormat":"do-v1"}', /must appear together/],
    [`{"op":"locked","parts":["${shell}"]}`, /must appear together/],
    [wasmLocked([shell], { heapFormat: 5 }), /heapFormat 5 must match/],
    [wasmLocked([shell], { heapFormat: '' }), /heapFormat "" must match/],
    [wasmLocked([shell], { heapFormat: 'Do-v1' }), /heapFormat "Do-v1"/],
    [wasmLocked([shell], { heapFormat: '-v1' }), /heapFormat "-v1"/],
    [wasmLocked([shell], { heapFormat: 'native' }), /"native" is reserved/],
    [wasmLocked([shell], { heapFormat: null }), /heapFormat null must/],
    [wasmLocked(/** @type {any} */ (shell)), /parts must be an array/],
    [wasmLocked([]), /parts must be an array of 1 to 16 paths/],
    [wasmLocked(tooMany), /parts must be an array of 1 to 16 paths/],
    [wasmLocked([5]), /part 5 must be an absolute path/],
    [wasmLocked(['shell.mjs']), /part "shell.mjs" must be an absolute path/],
    [wasmLocked(['/p/a b']), /part name "a b" must be a file name/],
    [wasmLocked(['/p/']), /part name "" must be a file name/],
    [wasmLocked(['/p/..']), /part name ".." must be a file name/],
    [wasmLocked(['/p/.']), /part name "." must be a file name/],
    [wasmLocked(['/p/0']), /part name "0" must not be all digits/],
    [wasmLocked(['/p/12']), /part name "12" must not be all digits/],
    [wasmLocked(['/p/x.tmp']), /part name "x.tmp" must not end in \.tmp/],
    [wasmLocked(['/p/x', '/q/x']), /part name "x" is repeated/],
  ])) {
    const host = makeFakeHost({ locked: line, extraFiles: partFiles });
    // eslint-disable-next-line no-await-in-loop
    const events = await refused(t, host, message);
    t.deepEqual(events, ['release'], line);
  }
});

test('malformed saved heap format or parts are invalid, not a type error', async t => {
  const host = makeFakeHost({ locked: wasmLocked(), extraFiles: partFiles });
  await acquire(t, host);
  const manifest = JSON.parse(host.texts.get(manifestPath) ?? '');
  const { heapFormat: _heapFormat, ...withoutHeapFormat } = manifest;
  const { parts: _parts, ...withoutParts } = manifest;
  for (const [saved, message] of /** @type {[unknown, RegExp][]} */ ([
    [withoutHeapFormat, /heapFormat and parts must appear together/],
    [withoutParts, /heapFormat and parts must appear together/],
    [{ ...manifest, heapFormat: 'native' }, /"native" is reserved/],
    [{ ...manifest, heapFormat: 7 }, /heapFormat 7 must match/],
    [{ ...manifest, parts: 'x' }, /parts must be an array of 1 to 16/],
    [{ ...manifest, parts: [] }, /parts must be an array of 1 to 16/],
    [{ ...manifest, parts: [['a.mjs']] }, /must be a \[name, digest\] pair/],
    [{ ...manifest, parts: [null] }, /part null must be a \[name, digest\]/],
    [{ ...manifest, parts: [['a.mjs', 3]] }, /must be a \[name, digest\]/],
    [{ ...manifest, parts: [[1, 'd']] }, /part name 1 must be a file name/],
    [{ ...manifest, parts: [['0', 'd']] }, /must not be all digits/],
  ])) {
    const text = JSON.stringify(saved);
    host.texts.set(manifestPath, text);
    const pattern = new RegExp(
      `^Invalid Ironhorse runtime\\.json: .*${message.source}`,
    );
    // eslint-disable-next-line no-await-in-loop
    const events = await refused(t, host, pattern);
    t.false(
      events.some(event => event.startsWith('copy')),
      text,
    );
  }
});
