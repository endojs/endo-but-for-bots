// @ts-check

/** @import { EndoHost } from '@endo/daemon' */
/** @import { EndoProvisionPersistence } from '../src/code-mode-provisioning-types.js' */

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeEndoProvisionSpec } from '../src/code-mode-provision-policy.js';
import { realizeEndoProvisionOnHost } from '../src/code-mode-provision-host.js';

/** @param {string | string[]} path */
const pathKey = path => (Array.isArray(path) ? path : [path]).join('/');

/**
 * @returns {{ host: EndoHost, identifiers: Map<string, string>, values: Map<string, unknown>, idValues: Map<string, unknown>, identifyCalls: string[][], guestBindings: Map<string, string> }}
 */
const makeHost = () => {
  const directories = new Set(['']);
  const identifiers = new Map();
  const values = new Map();
  const idValues = new Map();
  const identifyCalls = [];
  const guestBindings = new Map();
  const guest = {
    storeIdentifier: async (name, id) => {
      guestBindings.set(name, id);
    },
  };

  const makeDirectory = async path => {
    const names = Array.isArray(path) ? path : [path];
    for (let index = 1; index <= names.length; index += 1) {
      directories.add(pathKey(names.slice(0, index)));
    }
  };
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ ({
      has: async (...namePath) => {
        const name = pathKey(namePath);
        return (
          directories.has(name) || identifiers.has(name) || values.has(name)
        );
      },
      makeDirectory,
      identify: async (...namePath) => {
        identifyCalls.push([...namePath]);
        return identifiers.get(pathKey(namePath));
      },
      lookupById: async id => {
        if (!idValues.has(id)) {
          throw Error(`missing formula ${id}`);
        }
        return idValues.get(id);
      },
      lookup: async namePath => {
        const name = pathKey(namePath);
        const id = identifiers.get(name);
        if (id !== undefined) {
          return idValues.get(id);
        }
        if (values.has(name)) {
          return values.get(name);
        }
        if (name.endsWith('/guest-agent')) {
          return guest;
        }
        throw Error(`missing name ${name}`);
      },
      provideGuest: async (namePath, options) => {
        const handleName = pathKey(namePath);
        identifiers.set(handleName, 'guest-handle');
        idValues.set('guest-handle', guest);
        if (options?.agentName !== undefined) {
          const agentName = pathKey(options.agentName);
          identifiers.set(agentName, 'guest-agent');
          idValues.set('guest-agent', guest);
        }
        return guest;
      },
      storeIdentifier: async (namePath, id) => {
        identifiers.set(pathKey(namePath), id);
      },
      storeValue: async (value, namePath) => {
        values.set(pathKey(namePath), value);
      },
    })
  );
  return {
    host,
    identifiers,
    values,
    idValues,
    identifyCalls,
    guestBindings,
  };
};

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-provision-host-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

test.todo(
  'interrupted initial provisioning after policy storage before all named-grant aliases are installed still needs recovery behavior',
);

test('named grants pin the first host capability and bind only the guest alias', async t => {
  const root = await makeWorkspace(t);
  const fixture = makeHost();
  fixture.identifiers.set('tools', 'tools-directory');
  fixture.idValues.set('tools-directory', {});
  fixture.identifiers.set('tools/calendar', 'calendar-original');
  fixture.idValues.set('calendar-original', { version: 'original' });

  const persistence = await normalizeEndoProvisionSpec(
    {
      grants: {
        calendar: {
          from: ['tools', 'calendar'],
          description: 'A calendar service',
        },
      },
    },
    { harness: 'test', sessionId: 'pinned-grant', cwd: root },
  );
  await realizeEndoProvisionOnHost(fixture.host, persistence);

  const controllerPowerPath = [
    ...persistence.guestHandlePath.slice(0, -1),
    'grants',
    'calendar',
  ];
  t.is(
    fixture.identifiers.get(pathKey(controllerPowerPath)),
    'calendar-original',
  );
  t.is(fixture.guestBindings.get('calendar'), 'calendar-original');
  t.deepEqual(fixture.identifyCalls, [
    ['tools', 'calendar'],
    controllerPowerPath,
  ]);

  fixture.identifiers.set('tools/calendar', 'calendar-rebound');
  fixture.idValues.set('calendar-rebound', { version: 'rebound' });
  await realizeEndoProvisionOnHost(fixture.host, persistence);

  t.is(fixture.guestBindings.get('calendar'), 'calendar-original');
  t.deepEqual(
    fixture.identifyCalls,
    [['tools', 'calendar'], controllerPowerPath, controllerPowerPath],
    'reconstruction does not resolve the rebound source path',
  );
});

test('missing retained grant state and missing sources fail closed', async t => {
  const root = await makeWorkspace(t);
  const spec = {
    grants: { calendar: { from: ['tools', 'calendar'] } },
  };
  const first = makeHost();
  first.identifiers.set('tools', 'tools-directory');
  first.idValues.set('tools-directory', {});
  first.identifiers.set('tools/calendar', 'calendar-original');
  first.idValues.set('calendar-original', {});
  const persistence = await normalizeEndoProvisionSpec(spec, {
    harness: 'test',
    sessionId: 'missing-grant',
    cwd: root,
  });
  await realizeEndoProvisionOnHost(first.host, persistence);
  first.identifiers.delete(
    pathKey([
      ...persistence.guestHandlePath.slice(0, -1),
      'grants',
      'calendar',
    ]),
  );
  await t.throwsAsync(
    () => realizeEndoProvisionOnHost(first.host, persistence),
    {
      message: /refusing to re-resolve its host source/,
    },
  );

  const missing = makeHost();
  await t.throwsAsync(
    () => realizeEndoProvisionOnHost(missing.host, persistence),
    { message: /source.*not available on the host/ },
  );
});
