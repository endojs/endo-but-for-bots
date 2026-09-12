// @ts-check
import test from 'ava';
import { E } from '@endo/eventual-send';

/**
 * Shared lifecycle conformance for the native CLI factory adapters.
 * @param {(powers: any) => any} makeFactory
 * @param {() => any} makeToolSet
 * @param {boolean} [hasBroker]
 */
export const testCliCleanup = (makeFactory, makeToolSet, hasBroker = false) => {
  for (const failingStage of [
    'bridge-close',
    'cancel',
    ...(hasBroker ? ['revoke', 'evidence-revoke'] : []),
  ]) {
    test(`failed start retains ${failingStage} ownership before replacement or deletion`, async t => {
      const log = [];
      let busy = true;
      const stage =
        failingStage === 'evidence-revoke' ? 'revoke' : failingStage;
      const record = (name, sessionId) => log.push([name, sessionId]);
      const release = async (name, sessionId) => {
        record(name, sessionId);
        if (busy && sessionId === 'one' && name === stage)
          throw Error(`${name} busy`);
      };
      const factory = makeFactory({
        ...(hasBroker
          ? {
              broker: async ({ sessionId }) => {
                record('grant', sessionId);
                return harden({
                  attestation: async () => {
                    if (
                      sessionId === 'one' &&
                      failingStage === 'evidence-revoke'
                    )
                      throw Error('evidence failed');
                    return harden({ endpoint: 'http://127.0.0.1:41337' });
                  },
                  sandboxEvidence: async () =>
                    harden({ brokerSidecar: { container: 'listener' } }),
                  revoke: () => release('revoke', sessionId),
                });
              },
            }
          : {}),
        startToolBridge: async sessionId => {
          record('bridge', sessionId);
          return harden({
            socketDir: `/tmp/${sessionId}`,
            innerDir: '/endo-mcp',
            configPath: '/endo-mcp/mcp.json',
            pendingCalls: () => 0,
            close: () => release('bridge-close', sessionId),
          });
        },
        provisionClient: async sessionId => {
          record('provision', sessionId);
          if (sessionId === 'one') throw Error('partially provisioned client');
          return harden({
            terminate: async () => {
              record('stop', sessionId);
            },
          });
        },
        cancelClient: sessionId => release('cancel', sessionId),
        removeSession: async sessionId => {
          record('remove', sessionId);
        },
        removeToolBridge: async sessionId => {
          record('remove-bridge', sessionId);
        },
      });
      const create = sessionId =>
        E(factory).create(harden({ sessionId }), makeToolSet());
      const destroy = sessionId => E(factory).destroy(harden({ sessionId }));
      await t.throwsAsync(() => create('one'), {
        message: /provisioning and rollback failed/,
      });
      const first = log.filter(([, id]) => id === 'one').map(([name]) => name);
      const partial = failingStage !== 'evidence-revoke';
      t.deepEqual(first, [
        'bridge',
        ...(hasBroker ? ['grant'] : []),
        ...(partial ? ['provision', 'cancel'] : []),
        ...(hasBroker ? ['revoke'] : []),
        'bridge-close',
      ]);
      await t.throwsAsync(() => create('one'), {
        message: /cleanup remains pending/,
      });
      await t.throwsAsync(() => destroy('one'), {
        message: /cleanup remains pending/,
      });
      t.is(
        log.filter(([name, id]) => name === 'bridge' && id === 'one').length,
        1,
      );
      t.false(log.some(([name, id]) => name === 'remove' && id === 'one'));

      // A different session does not conflict with the failed incarnation.
      const other = await create('other');
      await E(other.admin).terminate();
      await destroy('other');
      t.deepEqual(
        log.filter(([, id]) => id === 'other').map(([name]) => name),
        [
          'bridge',
          ...(hasBroker ? ['grant'] : []),
          'provision',
          'stop',
          'cancel',
          ...(hasBroker ? ['revoke'] : []),
          'bridge-close',
          'remove',
          'remove-bridge',
        ],
      );

      busy = false;
      await destroy('one');
      const releases = log
        .filter(([, id]) => id === 'one')
        .map(([name]) => name);
      t.is(releases.filter(name => name === stage).length, 4);
      for (const independent of [
        'bridge-close',
        ...(partial ? ['cancel'] : []),
        ...(hasBroker ? ['revoke'] : []),
      ]) {
        if (independent !== stage)
          t.is(releases.filter(name => name === independent).length, 1);
      }
      t.deepEqual(releases.slice(-2), ['remove', 'remove-bridge']);
    });
  }
};
harden(testCliCleanup);
