// @ts-check
import '../unit/_m1a-prelude.js';
import test from 'ava';
import { E } from '@endo/far';
import { makeSlice, waitFor } from '../integration/_m1a-slice.js';
import { turnRecords } from '../integration/_m1b.js';
import {
  commandTurn,
  toolCall,
  toolResultsOf,
} from '../integration/_environments.js';
import {
  browserSkipReason,
  startBrowserGateway,
  trackSockets,
} from './_harness.mjs';

const skip = await browserSkipReason();
const run = skip === undefined ? test.serial : test.skip;
if (skip) test(`[browser] child inspection skipped: ${skip}`, t => t.pass());

run(
  '[browser] inspecting sibling subagents reads their own chat and inventory without running a turn',
  async t => {
    t.timeout(4 * 60_000);
    const { page, state, close, gatewayLog } = await startBrowserGateway({
      template: 'm2',
      initScript: trackSockets,
    });
    t.teardown(close);
    const slice = await makeSlice(state);
    const names = ['scout', 'scribe'];
    const made = await slice.makeBackend(
      harden({
        turns: [
          commandTurn('prepare children', [
            [
              toolCall('store', {
                petName: 'parent-only',
                value: 'parent data',
              }),
            ],
            ...names.map(name => [toolCall('spawnSubagent', { name })]),
            ...names.map(name => [
              toolCall('askSubagent', { name, task: `remember ${name}` }),
            ]),
          ]),
          ...names.map(name =>
            commandTurn(`remember ${name}`, [
              [
                toolCall('store', {
                  petName: `${name}-only`,
                  value: `${name} data`,
                }),
              ],
            ]),
          ),
          commandTurn('stop scout', [
            [toolCall('stopSubagent', { name: 'scout' })],
          ]),
        ],
      }),
    );
    const title = 'Inspection parent';
    const parent = await slice.createSession(made.backend, title);
    const act = async (/** @type {string} */ input) => {
      const { turn } = await slice.submit(parent, input);
      t.is((await E(turn).whenFinished()).state, 'completed');
      const results = toolResultsOf(await turnRecords(turn));
      t.true(
        results.length > 0 && results.every(r => !r.failed),
        JSON.stringify(results),
      );
    };
    await act('prepare children');
    const actions = () =>
      made
        .log()
        .filter(line =>
          ['request', 'echo-start', 'echo-end'].includes(line.kind),
        ).length;
    const operator = await E(slice.harness).getOperator();
    const children = await Promise.all(
      names.map(name => E(operator).findSubagentSession(parent, name)),
    );
    const activity = () =>
      Promise.all(
        [parent, ...children].map(async session => {
          const { turns } = await E(session).getHistoryPage();
          return Promise.all(
            turns.map(async (/** @type {any} */ turn) => ({
              id: turn.turnId,
              state: turn.state,
              results: toolResultsOf(await turnRecords(turn.turn)),
            })),
          );
        }),
      );
    const originalHistory = await activity();
    const baseline = actions();
    t.true(baseline > 0);
    await page.locator('.floot-session-item', { hasText: title }).click();
    const toggle = page.getByRole('button', {
      name: 'Agent inventory',
      exact: true,
    });
    const showInventory = async () => {
      await toggle.waitFor();
      if ((await toggle.getAttribute('aria-expanded')) !== 'true')
        await toggle.click();
    };
    const panel = page.locator('.thix-session-inventory');
    const item = (/** @type {string} */ label) =>
      panel.locator(`[data-label="${label}"]`);
    const path = page.getByRole('navigation', { name: 'Session path' });
    const back = path.getByRole('button', { name: title, exact: true });
    const chat = page.locator('.thix-transcript');
    const inspect = async (/** @type {string} */ name) => {
      await showInventory();
      await panel
        .getByRole('button', { name: `Inspect ${name}`, exact: true })
        .click();
      await back.waitFor();
      await chat
        .getByText(`remember ${name}`, { exact: false })
        .first()
        .waitFor();
      await showInventory();
      await item(`${name}-only`).waitFor();
      t.is(await item('parent-only').count(), 0);
      t.is(
        await item(`${name === 'scout' ? 'scribe' : 'scout'}-only`).count(),
        0,
      );
      t.is(await page.locator('textarea.floot-input:visible').count(), 0);
      t.is(
        await chat.getByText('prepare children', { exact: true }).count(),
        0,
      );
    };
    await inspect('scout');
    const reconnect = async () => {
      const count = await page.evaluate(() => {
        const sockets = /** @type {any} */ (globalThis).thixTest;
        sockets.drop();
        return sockets.opens.length;
      });
      await waitFor(
        async () =>
          (await page.evaluate(
            () => /** @type {any} */ (globalThis).thixTest.opens.length,
          )) > count,
        20_000,
        'replacement gateway socket',
      );
      await page
        .locator('.thix-overlay')
        .waitFor({ state: 'hidden', timeout: 20_000 });
    };
    await reconnect();
    await item('scout-only').waitFor();
    await back.click();
    await showInventory();
    await item('parent-only').waitFor();
    await chat.getByText('prepare children', { exact: true }).waitFor();
    await inspect('scribe');
    await back.click();
    await inspect('scout');
    t.is(
      actions(),
      baseline,
      'navigation and reconnect issued no provider rounds or echo calls',
    );
    t.deepEqual(
      await activity(),
      originalHistory,
      'parent and both children retained the same durable turns and tool results',
    );
    await act('stop scout');
    const afterStop = actions();
    await reconnect();
    await showInventory();
    await item('parent-only').waitFor();
    t.is(
      await panel
        .getByRole('button', { name: 'Inspect scout', exact: true })
        .count(),
      0,
    );
    await panel
      .getByRole('button', { name: 'Inspect scribe', exact: true })
      .waitFor();
    t.is(actions(), afterStop);
    t.deepEqual(gatewayLog.refused('method'), []);
  },
);
