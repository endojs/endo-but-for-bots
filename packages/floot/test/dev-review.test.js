// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeWorkflowService } from '@endo/workflow/src/service.js';
import { chartDiagnostics } from '@endo/workflow/machine.js';
import {
  makeFakeAgent,
  makeFakeClock,
  settle,
  // Test-only shared daemon fixture; deliberately not a public package export.
  // eslint-disable-next-line import/no-relative-packages
} from '../../workflow/test/fake-agent.js';
import { devReviewChart, provisionDevReview } from '../dev-review.js';
import { make as makeReader } from '../review-reader.js';
import { make as makeProject } from '../review-project.js';
import { make as makeConnection } from '../review-connection.js';
import { makeWorkflowTools } from '../src/workflow-tools.js';

const BASE = 'a'.repeat(40);
const FIRST = 'b'.repeat(40);
const SECOND = 'c'.repeat(40);

test('candidate pinning rejects moving refs before consulting Git', async t => {
  const refs = [];
  const project = makeProject(
    Far('GitReader', {
      revParse: ref => {
        refs.push(ref);
        return harden({ oid: FIRST });
      },
    }),
  );
  await t.throwsAsync(E(project).pinCandidate('HEAD', 'submission-1'), {
    message: /full commit object ID/,
  });
  t.deepEqual(refs, []);
  t.deepEqual(await E(project).pinCandidate(FIRST, 'submission-2'), {
    oid: FIRST,
  });
  t.deepEqual(refs, [FIRST, `${FIRST}^{commit}`]);
  // Symbolic bases remain supported: they are pinned before implementation.
  await E(project).revParse('main', 'base-1');
  t.is(refs[2], 'main');
});

test('design handoff pins candidates, repeats review, and durably notifies readiness', async t => {
  t.timeout(20_000);
  t.deepEqual(chartDiagnostics(devReviewChart).errors, []);
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const rawGit = makeExo(
    'StrictGitReader',
    M.interface('StrictGitReader', {
      revParse: M.callWhen(M.string()).returns(M.record()),
    }),
    {
      revParse: async ref =>
        harden({
          kind: 'commit',
          name: ref,
          oid: ref === 'main' ? BASE : ref.replace(/\^\{commit\}$/, ''),
        }),
    },
  );
  const project = makeProject(rawGit);
  const h1 = await makeWorkflowService({ powers, clock });
  t.teardown(h1.stop);
  const { fid } = await E(h1.service).makeFactory(
    harden({
      chart: devReviewChart,
      params: { projectName: 'project', reviewers: ['alice', 'bob'] },
      endowments: {
        project,
        developer: {},
        alice: {},
        bob: {},
        operator: {},
        initiator: {},
      },
    }),
  );
  await E(powers).storeValue(h1.service, 'service');
  await E(powers).storeValue(fid, 'factory-id');
  await E(powers).storeValue(await makeConnection(powers), 'dev-review');
  const tools = makeWorkflowTools(powers);
  const design =
    'Add a search box. Acceptance: keyboard navigation and a regression test.';
  const handoff = tools.get('handoffDesign');
  await handoff.execute({
    name: 'search',
    title: 'Search',
    design,
    base: 'main',
    rounds: '2',
  });
  await settle(300);
  const firstAsk = controls.findMessage('request', 'Implement');
  t.true(firstAsk.description.includes(design));
  t.true(firstAsk.description.includes(BASE));
  await controls.resolveRequest(firstAsk, harden({ head: FIRST }));
  await settle(300);
  let panel = (await E(powers).listMessages()).filter(m =>
    m.description?.includes('Review round'),
  );
  t.is(panel.length, 2);
  await controls.resolveRequest(
    panel[0],
    harden({ approve: false, feedback: 'Cover Escape.' }),
  );
  await controls.resolveRequest(
    panel[1],
    harden({ approve: true, feedback: 'Other behavior is correct.' }),
  );
  await settle(300);
  const retry = controls.findMessage('request', 'Implement');
  t.true(retry.description.includes('Cover Escape.'));
  t.is(controls.messageCount('request', 'Your design'), 0);
  await controls.resolveRequest(retry, harden({ head: SECOND }));
  await settle(300);
  panel = (await E(powers).listMessages()).filter(
    m =>
      m.description?.includes('Review round') && m.description.includes(SECOND),
  );
  for (const ask of panel) {
    // eslint-disable-next-line no-await-in-loop
    await controls.resolveRequest(
      ask,
      harden({ approve: true, feedback: 'Approved.' }),
    );
  }
  await settle(300);
  const notice = controls.findMessage('request', 'Your design');
  t.true(notice.description.includes(SECOND));
  const before = await E(h1.service).list();
  const runId = before[0].runId;
  h1.stop();
  const h2 = await makeWorkflowService({ powers: controls.restart(), clock });
  t.teardown(h2.stop);
  await E(powers).storeValue(h2.service, 'service');
  await E(powers).storeValue(await makeConnection(powers), 'dev-review');
  await settle(200);
  t.is(controls.messageCount('request', 'Your design'), 1);
  await t.throwsAsync(
    E(await E(powers).lookup('dev-review')).setRemaining(runId, 9n),
    { message: /Budget update was not applied/ },
  );
  await controls.resolveRequest(notice, harden({ acknowledged: true }));
  await settle(200);
  const statusText = await tools
    .get('reviewStatus')
    .execute({ name: 'search' });
  t.true(statusText.includes(SECOND));
  const foreign = await E(h2.service).start(
    harden({
      name: 'foreign',
      version: 1,
      initial: 'wait',
      states: { wait: {} },
    }),
  );
  const connection = await E(powers).lookup('dev-review');
  await t.throwsAsync(E(connection).status(foreign.runId), {
    message: /another factory/,
  });
  await t.throwsAsync(E(connection).cancel(foreign.runId, 'stop'), {
    message: /another factory/,
  });
  t.deepEqual((await E(await E(h2.service).run(runId)).status()).output, {
    status: 'ready',
    head: SECOND,
    base: BASE,
    round: 1n,
  });
});

test('provisioning registers attenuated capabilities before granting them', async t => {
  const registered = new WeakSet();
  const stores = new Map();
  const register = value => {
    registered.add(value);
    return value;
  };
  const guest = name => {
    const values = new Map();
    stores.set(name, values);
    values.set('@self', register(Far(`${name} mail`, {})));
    return register(
      Far(name, {
        has: key => values.has(key),
        lookup: key => values.get(key),
        storeValue: (value, key) => {
          if (
            typeof value === 'object' &&
            value !== null &&
            !registered.has(value)
          )
            throw Error('Capability has no daemon formula');
          values.set(key, value);
        },
      }),
    );
  };
  const reader = Far('Reader', { revParse: () => harden({ oid: BASE }) });
  const project = register(Far('Writer', { readOnly: () => reader }));
  /** @type {{ params: { reviewers: string[] }, endowments: { project: unknown } } | undefined} */
  let factoryConfig;
  const service = register(
    Far('Service', {
      makeFactory: config => {
        factoryConfig = config;
        return harden({ fid: 'factory-test', factory: Far('Factory', {}) });
      },
    }),
  );
  const hostPowers = guest('host');
  /** @type {Map<string, (powers: any) => object | Promise<object>>} */
  const modules = new Map();
  modules.set('review-reader.js', makeReader);
  modules.set('review-project.js', makeProject);
  modules.set('review-connection.js', makeConnection);
  const host = Far('Host', {
    has: key => E(hostPowers).has(key),
    lookup: key => E(hostPowers).lookup(key),
    storeValue: (value, key) => E(hostPowers).storeValue(value, key),
    provideGuest: async (_handle, { agentName }) => {
      await E(hostPowers).storeValue(guest(agentName), agentName);
    },
    makeUnconfined: async (_worker, url, { powersName, resultName }) => {
      const moduleName = new URL(url).pathname.split('/').pop();
      if (moduleName === undefined) throw Error('Missing module name');
      const make = modules.get(moduleName);
      if (make === undefined) throw Error(`Unknown module ${moduleName}`);
      const value = await make(await E(hostPowers).lookup(powersName));
      await E(hostPowers).storeValue(register(value), resultName);
    },
  });
  const developer = guest('developer');
  const reviewer = guest('reviewer');
  const initiator = guest('initiator');
  const options = {
    host,
    service,
    project,
    projectName: 'project',
    developer,
    reviewers: [reviewer],
    initiator,
    operator: register(Far('Operator', {})),
  };
  const { fid } = await provisionDevReview(options);
  t.is(fid, 'factory-test');
  t.is(stores.get('developer').get('project'), project);
  t.is(stores.get('reviewer').get('project'), reader);
  t.true(registered.has(stores.get('initiator').get('dev-review')));
  if (factoryConfig === undefined) throw Error('Factory was not provisioned');
  t.deepEqual(factoryConfig.params.reviewers, ['reviewer-0']);
  t.not(factoryConfig.endowments.project, project);
  await t.throwsAsync(provisionDevReview(options), {
    message: 'This conversation already has a dev-review connection',
  });
});

test('budget updates survive pending base and candidate resolution', async t => {
  t.timeout(20_000);
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const pending = new Map();
  const project = Far('SlowProject', {
    revParse: ref => new Promise(resolve => pending.set(ref, resolve)),
    pinCandidate: ref => new Promise(resolve => pending.set(ref, resolve)),
  });
  const h = await makeWorkflowService({ powers, clock });
  t.teardown(h.stop);
  const { run, runId } = await E(h.service).start(
    devReviewChart,
    harden({
      params: {
        title: 'Budget',
        summary: 'Design',
        base: 'main',
        rounds: 2n,
        projectName: 'project',
        reviewers: ['reviewer'],
      },
      endowments: {
        project,
        developer: {},
        reviewer: {},
        operator: {},
        initiator: {},
      },
    }),
  );
  await settle(200);
  t.is((await E(run).status()).configuration.state, 'resolve-base');
  const port = await E(await E(h.service).control(runId)).port('initiator');
  await E(port).submit(
    harden({ type: 'set-remaining', value: { remaining: 5n } }),
  );
  pending.get('main')(harden({ oid: BASE }));
  await settle(200);
  t.is((await E(run).status()).context.remaining, 5n);
  await controls.resolveRequest(
    controls.findMessage('request', 'Implement'),
    harden({ head: FIRST }),
  );
  await settle(200);
  t.is((await E(run).status()).configuration.state, 'pin-candidate');
  await E(port).submit(
    harden({ type: 'set-remaining', value: { remaining: 7n } }),
  );
  pending.get(FIRST)(harden({ oid: FIRST }));
  await settle(200);
  t.is((await E(run).status()).configuration.state, 'review');
  t.is((await E(run).status()).context.remaining, 7n);
});
