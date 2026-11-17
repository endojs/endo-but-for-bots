// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import {
  exportFlootObjects,
  importFlootObjects,
  parseFlootTransfer,
} from '../../floot-transfer.js';

const locator = number =>
  `endo://${'a'.repeat(64)}/${number.repeat(64)}?type=eval`;
const exported = JSON.stringify({
  format: 'endo-floot',
  version: 1,
  controller: locator('b'),
  stt: locator('c'),
  tts: locator('d'),
});

test('import validates every locator before mutation and repairs a partial import', async t => {
  t.timeout(5000);
  const values = new Map();
  let exists = false;
  let fail = true;
  let writes = 0;
  const directory = Far('Directory', {
    has: key => values.has(key),
    locate: key => values.get(key),
  });
  const powers = Far('Host', {
    has: () => exists,
    makeDirectory: () => {
      exists = true;
      writes += 1;
    },
    lookup: () => directory,
    adoptFromLocator: (value, path) => {
      if (path[1] === 'stt' && fail) {
        fail = false;
        throw Error('connection lost');
      }
      values.set(path[1], value);
      writes += 1;
    },
  });
  await t.throwsAsync(
    () =>
      importFlootObjects(
        powers,
        exported.replace(locator('d'), 'https://wrong'),
      ),
    { message: /Invalid locator/ },
  );
  t.is(writes, 0);
  await t.throwsAsync(() => importFlootObjects(powers, exported), {
    message: /connection lost/,
  });
  const imported = await importFlootObjects(powers, exported);
  t.is(imported.profilePath[1], 'controller');
  t.deepEqual([...values.keys()], ['controller', 'stt', 'tts']);
  const completedWrites = writes;
  t.deepEqual(await importFlootObjects(powers, exported), imported);
  t.is(writes, completedWrites);
  values.set('controller', locator('f'));
  await t.throwsAsync(() => importFlootObjects(powers, exported), {
    message: /another object/,
  });
});

test('export contains only selected object locators and preserves transport hints', async t => {
  const powers = Far('Host', {
    locateWithHints: (...path) => locator(path[0]),
  });
  const text = await exportFlootObjects(powers, {
    profilePath: ['b'],
    audioPath: ['c'],
  });
  t.deepEqual(parseFlootTransfer(text), {
    format: 'endo-floot',
    version: 1,
    controller: locator('b'),
    stt: locator('c'),
  });
  t.throws(
    () =>
      parseFlootTransfer(
        JSON.stringify({ ...JSON.parse(text), gatewayPassword: 'secret' }),
      ),
    { message: /Unknown/ },
  );
  t.throws(() => parseFlootTransfer('x'.repeat(16_385)), {
    message: /too large/,
  });
});
