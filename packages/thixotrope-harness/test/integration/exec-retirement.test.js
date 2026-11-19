// @ts-check
import '../unit/_m1a-prelude.js';

import test from 'ava';
import { E } from '@endo/far';

/* eslint-disable-next-line import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, waitFor } from './_m1a-slice.js';
import {
  execScript,
  execTemplate,
  execTurn,
  isExecVat,
  UNSET,
} from './_m1b-exec.js';

takeIntegrationLock(test, 'm1b exec worker retirement');
const run = integrationEnabled ? test.serial : test.skip;

run(
  'a bounded sleep past its deadline retires the worker and the next task uses a fresh scope',
  async t => {
    t.timeout(3 * 60_000);
    const state = await startFromTemplate(await execTemplate(), { t });
    const slice = await makeSlice(state);
    // With no warm exec spares, each observed exec worker belongs to this session.
    await E(slice.harness).configure(
      harden({ spareExec: 0, execDeadlineMs: 5000 }),
    );
    await E(slice.harness).whenSettled();
    const workers = async () => {
      const rows = await slice.workers();
      return rows.filter(isExecVat);
    };
    await waitFor(
      async () => {
        const rows = await workers();
        return rows.length === 0;
      },
      30_000,
      'the exec spare to retire',
    );
    const inputs = ['exec set', 'exec sleep30', 'exec get'];
    const { backend } = await slice.makeBackend(
      harden({
        turns: execScript.turns.filter(turn => inputs.includes(turn.input)),
      }),
    );
    const session = await slice.createSession(backend, 'bounded retirement');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const first = await execTurn(slice, session, live, 'exec set');
    t.is(first.endStatus, 'completed');
    t.is(first.result, '5');
    const before = await workers();
    t.is(before.length, 1);
    const oldId = before[0].workerId;

    const sleep = await execTurn(slice, session, live, 'exec sleep30');
    t.is(sleep.endStatus, 'completed');
    t.is(sleep.result, textOf.errorResult(textOf.execTimeout(5000)));
    const retired = await waitFor(
      async () => {
        const after = await workers();
        return before.filter(w => !after.some(a => a.workerId === w.workerId))
          .length;
      },
      30_000,
      'a previous exec worker to retire',
      250,
    );
    t.is(retired, 1);

    await E(slice.harness).configure(harden({ execDeadlineMs: 120_000 }));
    const next = await execTurn(slice, session, live, 'exec get');
    t.is(next.endStatus, 'completed');
    t.is(next.result, UNSET);
    const after = await workers();
    t.is(after.length, 1);
    t.not(after[0].workerId, oldId);
    t.log({
      oldId,
      newId: after[0].workerId,
      retired,
      nextStatus: next.endStatus,
    });
  },
);
