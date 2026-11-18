// @ts-check
// XC (cross-lane merge): adapter tools offered to the model through the
// generic tool-table entry (D-M4-9 as amended; m5-interfaces.md 2.8 S1,
// m4-interfaces.md 6), and the display label of an adopted tool grant
// (`ToolGrantInfo.label`, m5-interfaces.md 2.6).
//
// - a port tool with a description and no static entry is offered once, in
//   port order after the static table, and its call is a send to that
//   port's tool object with the opId and the argument text;
// - a port tool without a description, or whose description names another
//   tool, is not offered; a port tool named like a static entry never
//   shadows it (the static entry answers, available or not);
// - a granted tool named like an offered adapter tool is refused-builtin;
// - the generic entry is reused while the ports are;
// - `AdapterToolEntry` admits the description; the agent host's
//   `adapterTools` row for accountStatus carries the one the model sees;
// - `grant(tool, 'adopted', label)` shows `label` in `ToolGrantInfo`, which
//   the shape admits; an operator grant has none.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes } from '../../guest/lib/interfaces.js';
import {
  adapterToolEntries,
  toolSetFor,
  toolSources,
  toolTable,
} from '../../guest/session/tool-table.js';
import { makeGrants } from '../../guest/session/tools/granted.js';
/* eslint-enable import/no-relative-packages */
import { adapterTools } from '../../resources/agent-host/impl/index.js';
import { accountStatusDescription } from '../../resources/agent-host/impl/subscriptions/account-tool.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const AT = 1_700_000_000_000;
const drain = () => new Promise(resolve => setImmediate(resolve));

/** @param {string} name */
const descriptionOf = name =>
  harden({
    name,
    description: `The ${name} adapter tool.`,
    parameters: '{"type":"object"}',
  });

/**
 * An adapter tool that records its calls.
 * @param {string} name
 */
const recordingTool = name => {
  /** @type {any[]} */
  const calls = [];
  const tool = Far('AdapterTool', {
    /** @param {any} request */
    execute: request => {
      calls.push(request);
      return harden({ status: 'ok', text: `${name} ran` });
    },
  });
  return { tool, calls };
};

/**
 * @param {any[]} tools port tool records
 */
const portsWith = tools =>
  harden({
    endpoint: Far('Endpoint', {}),
    publisher: Far('LivePublisher', {}),
    writers: Far('BlobWriters', {}),
    tools: harden(tools),
    since: AT,
  });

/** @param {any} set */
const offered = set => set.descriptions.map((/** @type {any} */ d) => d.name);

test('an adapter tool with a description and no static entry is offered and its call goes to the tool object', async t => {
  const account = recordingTool('accountStatus');
  const echo = recordingTool('echo');
  const ports = portsWith([
    { name: 'echo', tool: echo.tool },
    {
      name: 'accountStatus',
      tool: account.tool,
      description: descriptionOf('accountStatus'),
    },
  ]);
  const set = toolSetFor(ports, toolTable, harden({}), harden([]));
  const names = offered(set);
  t.is(names.filter(n => n === 'accountStatus').length, 1);
  // After every available static entry (the adapter tools follow the table).
  t.is(names[names.length - 1], 'accountStatus');
  t.deepEqual(
    set.descriptions.find((/** @type {any} */ d) => d.name === 'accountStatus'),
    descriptionOf('accountStatus'),
  );
  const entry = /** @type {any} */ (set.byName.get('accountStatus'));
  t.is(entry.site, 'adapter');
  const outcome = await entry.execute(
    harden({ opId: 'op-1', args: '{"refresh":true}', turnId: 't-1' }),
    ports,
    harden({}),
  );
  t.deepEqual(outcome, { status: 'ok', text: 'accountStatus ran' });
  t.deepEqual(account.calls, [{ opId: 'op-1', args: '{"refresh":true}' }]);
  // echo is still the static entry (it sends to the echo of the ports).
  t.not(set.byName.get('echo'), undefined);
  t.true(toolTable.includes(/** @type {any} */ (set.byName.get('echo'))));
  // The generic entry is the same object while the ports are.
  const again = toolSetFor(ports, toolTable, harden({}), harden([]));
  t.is(again.byName.get('accountStatus'), entry);
});

test('no description, a description of another name, or a static name: not offered generically', t => {
  const plain = recordingTool('plain');
  const liar = recordingTool('liar');
  const shadow = recordingTool('exec');
  const echo = recordingTool('echo');
  const ports = portsWith([
    { name: 'plain', tool: plain.tool },
    { name: 'liar', tool: liar.tool, description: descriptionOf('other') },
    { name: 'exec', tool: shadow.tool, description: descriptionOf('exec') },
    { name: 'echo', tool: echo.tool, description: descriptionOf('echo') },
  ]);
  t.deepEqual(adapterToolEntries(ports, toolTable), []);
  const set = toolSetFor(ports, toolTable, harden({}), harden([]));
  const names = offered(set);
  t.false(names.includes('plain'));
  t.false(names.includes('liar'));
  t.false(names.includes('other'));
  // `exec` is the static entry's (unavailable without an exec vat), never
  // the port's; `echo` is the static entry with its own description.
  t.false(names.includes('exec'));
  t.is(set.byName.get('exec'), undefined);
  t.true(toolTable.includes(/** @type {any} */ (set.byName.get('echo'))));
  t.notDeepEqual(
    set.descriptions.find((/** @type {any} */ d) => d.name === 'echo'),
    descriptionOf('echo'),
  );
});

test('a granted tool named like an offered adapter tool is refused-builtin', async t => {
  const account = recordingTool('accountStatus');
  const ports = portsWith([
    {
      name: 'accountStatus',
      tool: account.tool,
      description: descriptionOf('accountStatus'),
    },
  ]);
  /** @type {any} */
  let part;
  const runtime = harden({
    services: harden({}),
    get grants() {
      return part;
    },
  });
  const tool = Far('tool accountStatus', {});
  part = makeGrants(runtime, {
    inspectFor: () => async () =>
      harden({ status: 'ok', description: descriptionOf('accountStatus') }),
  });
  toolSetFor(ports, toolTable, harden({}), toolSources, runtime);
  part.facet.grantTool(tool);
  await drain();
  const set = toolSetFor(ports, toolTable, harden({}), toolSources, runtime);
  t.deepEqual(
    set.refused.map((/** @type {any} */ r) => [r.entry.name, r.state]),
    [['accountStatus', 'refused-builtin']],
  );
  // The offered one is the adapter's.
  t.is(/** @type {any} */ (set.byName.get('accountStatus')).site, 'adapter');
});

test('AdapterToolEntry admits a description; the accountStatus row carries the one the model sees', t => {
  const tool = Far('AdapterTool', { execute: () => undefined });
  t.true(matches(harden({ name: 'echo', tool }), shapes.AdapterToolEntry));
  t.true(
    matches(
      harden({
        name: 'accountStatus',
        tool,
        description: accountStatusDescription,
      }),
      shapes.AdapterToolEntry,
    ),
  );
  t.false(
    matches(
      harden({ name: 'x', tool, description: 'text' }),
      shapes.AdapterToolEntry,
    ),
  );
  const row = adapterTools.find(entry => entry.name === 'accountStatus');
  t.is(row?.description, accountStatusDescription);
  t.true(matches(accountStatusDescription, shapes.ToolDescription));
  // echo has a static tool-table entry and needs none.
  t.is(
    adapterTools.find(entry => entry.name === 'echo')?.description,
    undefined,
  );
});

test('an adopted grant shows its display label; an operator grant has none (2.6)', async t => {
  /** @type {any} */
  let part;
  const runtime = harden({
    services: harden({}),
    get grants() {
      return part;
    },
  });
  part = makeGrants(runtime, {
    inspectFor: () => async () =>
      harden({ status: 'ok', description: descriptionOf('lookupWeather') }),
  });
  toolSetFor(portsWith([]), toolTable, harden({}), toolSources, runtime);
  const adopted = part.grant(Far('tool', {}), 'adopted', 'weather');
  const operator = part.facet.grantTool(Far('tool', {}));
  const info = await part.schemaRead(adopted);
  t.like(info, {
    state: 'offered',
    source: 'adopted',
    name: 'lookupWeather',
    label: 'weather',
  });
  t.true(matches(info, shapes.ToolGrantInfo));
  const plain = await part.schemaRead(operator);
  t.is(plain.label, undefined);
  t.false('label' in plain);
  t.deepEqual(
    part.facet.list().map((/** @type {any} */ i) => i.label),
    ['weather', undefined],
  );
  t.false(
    matches(
      harden({ ...info, label: 'a/b'.repeat(100) }),
      shapes.ToolGrantInfo,
    ),
  );
});
