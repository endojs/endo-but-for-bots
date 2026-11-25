// @ts-check
// R4-70: a development subagent gets a new workspace and shell when it is
// spawned. Stopping the parent keeps its environment withdrawn while the
// operator uses the child's explicitly delegated handle. A child hands its
// commits back to its parent as a git bundle through a drop box the parent
// published and attached at the spawn (the project preset's hand-back).
import '../unit/_m1a-prelude.js';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import { E } from '@endo/far';

import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice } from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';
import {
  commandCall,
  commandTurn,
  environmentKeys,
  environmentsTemplate,
  execCall,
  startEnvironmentSession,
  toolCall,
  toolResultsOf,
} from './_environments.js';

takeIntegrationLock(test, 'subagent environment isolation');
const run = integrationEnabled ? test.serial : test.skip;
/** @type {Awaited<ReturnType<typeof environmentsTemplate>>} */
let template;
if (integrationEnabled) {
  test.before(async t => {
    t.timeout(5 * 60_000);
    template = await environmentsTemplate();
  });
}

run(
  'a child has its own workspace and shell while the parent is stopped',
  async t => {
    t.timeout(5 * 60_000);
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const script = harden({
      turns: [
        commandTurn('mark parent', [
          [commandCall('sh', ['-c', 'printf parent > owner'])],
        ]),
        commandTurn('create child', [
          [toolCall('spawnSubagent', { name: 'helper' })],
          [
            toolCall('send', {
              recipient: 'user',
              strings: ['Helper: '],
              edgeNames: ['helper'],
              petNames: ['subagents/helper'],
            }),
          ],
        ]),
        commandTurn('record ownership', [
          [
            commandCall('sh', [
              '-c',
              'test ! -e owner && printf child > owner',
            ]),
          ],
          [
            execCall(
              "const workspace = await E(powers).lookup('workspace'); await E(workspace).add(['owner']); return E(workspace).commit('child owns this workspace');",
            ),
          ],
        ]),
      ],
    });
    const { backend } = await slice.makeBackend(script);
    const baselineKeys = new Set(environmentKeys(state.root));
    const parent = await startEnvironmentSession(slice, backend);
    const live = await slice.subscribe(parent);
    t.teardown(() => live.stop());
    const workspace = (/** @type {string} */ key) =>
      path.join(state.root, 'environments', 'sessions', key, 'workspace');
    await runTurn(slice, parent, live, 'mark parent');
    const newKeys = environmentKeys(state.root).filter(
      key => !baselineKeys.has(key),
    );
    t.is(newKeys.length, 1);
    const [parentKey] = newKeys;
    const parentDir = workspace(parentKey);
    t.is(await readFile(path.join(parentDir, 'owner'), 'utf8'), 'parent');
    const turn = await runTurn(slice, parent, live, 'create child');
    t.deepEqual(
      toolResultsOf(await turnRecords(turn.turn)).map(result => result.failed),
      [false, false],
    );
    const mailbox = await E(E(slice.harness).getOperator()).getMail();
    const { messages } = await E(mailbox).list();
    const helper = await E(messages[0].message).take('helper');
    t.is((await E(parent).emergencyStop()).state, 'stopped');
    const answer = await E(helper).ask(
      harden({ task: 'record ownership', attachments: [], at: Date.now() }),
    );
    t.is(answer.text, 'done');
    const keys = environmentKeys(state.root).filter(
      key => !baselineKeys.has(key),
    );
    t.is(keys.length, 2);
    const childKey = keys.find(key => key !== parentKey);
    t.truthy(childKey);
    const childDir = workspace(/** @type {string} */ (childKey));
    t.is(await readFile(path.join(parentDir, 'owner'), 'utf8'), 'parent');
    t.is(await readFile(path.join(childDir, 'owner'), 'utf8'), 'child');
    const { execFileSync } = await import('node:child_process');
    const subject = (/** @type {string} */ cwd) =>
      execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd,
        encoding: 'utf8',
      }).trim();
    t.is(subject(parentDir), 'Initialize workspace');
    t.is(subject(childDir), 'child owns this workspace');
    t.is((await E(parent).getExecutionState()).state, 'stopped');
  },
);

run(
  'a child uses delegated copy data and the same published counter',
  async t => {
    t.timeout(5 * 60_000);
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const data = { json: 'ordinary field', nested: [0, false, null] };
    const script = harden({
      turns: [
        commandTurn('delegate mixed values', [
          [
            execCall(
              "let n = 0; await powers.publish('counter', { increment() { return ++n; } }); return true;",
            ),
          ],
          [toolCall('store', { petName: 'data', value: data })],
          [
            toolCall('spawnSubagent', {
              name: 'reader',
              attachments: [
                { name: 'counter', petName: 'counter' },
                { name: 'seed', petName: 'data' },
              ],
            }),
          ],
          [
            toolCall('askSubagent', {
              name: 'reader',
              task: 'return mixed values',
              attachments: [{ name: 'parcel', petName: 'data' }],
            }),
          ],
          [execCall("return E(await powers.lookup('counter')).increment();")],
        ]),
        commandTurn('return mixed values', [
          [
            toolCall('adopt', {
              messageNumber: 1,
              edgeName: 'parcel',
              petName: 'received',
            }),
          ],
          [
            execCall(
              "const seed = await powers.lookup('seed'); const parcel = await powers.lookup('received'); const n = await E(await powers.lookup('counter')).increment(); await powers.store('proof', {seed,parcel,n}); return true;",
            ),
          ],
          [
            toolCall('send', {
              recipient: 'user',
              strings: ['proof '],
              edgeNames: ['proof'],
            }),
          ],
        ]),
        commandTurn('copy as address', [
          [
            toolCall('send', {
              recipient: 'data',
              strings: ['invalid destination'],
            }),
          ],
        ]),
      ],
    });
    const { backend } = await slice.makeBackend(script);
    const parent = await startEnvironmentSession(slice, backend);
    const live = await slice.subscribe(parent);
    t.teardown(() => live.stop());
    const turn = await runTurn(slice, parent, live, 'delegate mixed values');
    const results = toolResultsOf(await turnRecords(turn.turn));
    t.deepEqual(
      results.map(r => r.failed),
      [false, false, false, false, false],
      JSON.stringify(results),
    );
    t.is(results.at(-1)?.result, '2');
    const mailbox = await E(E(slice.harness).getOperator()).getMail();
    const { messages } = await E(mailbox).list();
    const row = messages.find(
      (/** @type {any} */ m) => m.body === 'proof @proof',
    );
    t.truthy(row);
    const { json } = await E(row.message).take('proof');
    t.deepEqual(JSON.parse(json), { seed: data, parcel: data, n: 1 });
    const refused = await runTurn(slice, parent, live, 'copy as address');
    const [failure] = toolResultsOf(await turnRecords(refused.turn));
    t.true(failure.failed);
    t.regex(
      failure.result,
      /No mail recipient is held under the petname "data"/u,
    );
  },
);

run(
  'a child hands its commits back as a bundle through a published drop box',
  async t => {
    t.timeout(5 * 60_000);
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const script = harden({
      turns: [
        commandTurn('delegate', [
          [
            execCall(
              "let p = []; await powers.publish('handback-impl', { clear() { p = []; return 0; }, put(s) { p.push(s); return p.length; }, count() { return p.length; }, piece(i) { return p[i]; } }); return true;",
            ),
          ],
          [
            toolCall('spawnSubagent', {
              name: 'impl',
              attachments: [{ name: 'handback', petName: 'handback-impl' }],
            }),
          ],
          [toolCall('askSubagent', { name: 'impl', task: 'hand back' })],
          [
            execCall(
              // eslint-disable-next-line no-template-curly-in-string -- exec code
              "const sh = await E(powers).lookup('shell'), box = await E(powers).lookup('handback-impl'); const n = await E(box).count(); for (let i = 0; i < n; i += 1) await E(sh).runCommand('sh', ['-c', 'printf %s \"$1\" >> .git/impl.b64', 'sh', await E(box).piece(i)]); const r = await E(sh).runCommand('sh', ['-c', 'base64 -d .git/impl.b64 > .git/impl.bundle && git fetch -q .git/impl.bundle HEAD:impl && git log -1 --format=%s impl && git cat-file -s impl:big']); return `${n} ${r.exitCode} ${r.stdout.trim()} ${r.stderr.trim()}`;",
            ),
          ],
        ]),
        commandTurn('hand back', [
          [
            execCall(
              // eslint-disable-next-line no-template-curly-in-string -- exec code
              "let out; try { const box = await E(powers).lookup('handback'); const sh = await E(powers).lookup('shell'), ws = await E(powers).lookup('workspace'); const run = c => E(sh).runCommand('sh', ['-c', c]); await run('head -c 6000 /dev/urandom > big && printf child > note'); await E(ws).add(['big', 'note']); await E(ws).commit('child work'); const made = await run('git bundle create .git/hb.bundle HEAD && base64 -w0 .git/hb.bundle > .git/hb && wc -c < .git/hb'); const n = Number(made.stdout); await E(box).put('stale'); await E(box).clear(); for (let i = 0; i < n; i += 2000) await E(box).put((await run(`cut -c ${i + 1}-${i + 2000} .git/hb`)).stdout.trim()); out = { ok: await E(box).count(), made }; } catch (e) { out = { err: String(e?.stack ?? e) }; } await powers.store('out', out); return out;",
            ),
          ],
          [
            toolCall('send', {
              recipient: 'user',
              strings: ['handback '],
              edgeNames: ['out'],
            }),
          ],
        ]),
      ],
    });
    const { backend } = await slice.makeBackend(script);
    const parent = await startEnvironmentSession(slice, backend);
    const live = await slice.subscribe(parent);
    t.teardown(() => live.stop());
    const turn = await runTurn(slice, parent, live, 'delegate');
    const results = toolResultsOf(await turnRecords(turn.turn));
    t.deepEqual(
      results.map(r => r.failed),
      [false, false, false, false],
      JSON.stringify(results),
    );
    // 6000 random bytes: a bundle of more than 8000 base64 characters, so
    // at least five pieces of 2000.
    const answer = results[3].result;
    const text = answer.startsWith('"') ? JSON.parse(answer) : answer;
    const got = /^(\d+) 0 child work\n6000 $/u.exec(text);
    const mailbox = await E(E(slice.harness).getOperator()).getMail();
    const { messages } = await E(mailbox).list();
    const row = messages.find(
      (/** @type {any} */ m) => m.body === 'handback @out',
    );
    const child = row && (await E(row.message).take('out'));
    t.truthy(got, JSON.stringify({ results, child }));
    t.true(Number(got?.[1]) >= 5, text);
  },
);
