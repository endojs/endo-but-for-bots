// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { reclaimRecordedMount } from './recorded-cleanup.js';

const SupervisorInterface = M.interface('HostedSessionSupervisor', {
  activate: M.call(M.string(), M.remotable()).returns(M.promise()),
  send: M.call(M.string()).optional(M.record()).returns(M.promise()),
  interrupt: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  terminate: M.call(M.string(), M.remotable()).returns(M.promise()),
});

/**
 * @typedef {'sandbox' | 'broker' | 'mounter' | 'mcp' | 'client'} ResourceRole
 * @typedef {{value: any, released: boolean, failed?: boolean, flight?: Promise<void>}} Resource
 * @typedef {{
 *   own: <T>(role: ResourceRole, value: T) => T,
 *   assertOpen: () => void,
 * }} ActivationOwner
 */

/**
 * @template Reply
 * @typedef {{send: (prompt: string, options?: any) => Promise<Reply>,
 *   interrupt: () => Promise<void>, status: () => Promise<any>,
 *   terminate: () => Promise<void>}} NativeClient
 */

/**
 * Own one native incarnation beneath the daemon's durable session owner.
 * The adapter validates its plan and constructs its CLI; it transfers every
 * partial acquisition here before starting it. It does not own a second stop
 * algorithm, and its client must not call back into this owner's cleanup.
 *
 * Stop fences immediately. Client shutdown, grant revocation, MCP admission
 * closure and sandbox reaping begin independently: none can hold revocation
 * hostage. Mount release depends on proven sandbox closure. Late acquisitions
 * are retained and closed, failed releases remain retryable, and successful
 * releases are never repeated. Native acknowledgement, not a timeout, permits
 * the daemon to delete the incarnation and subsequently remove its storage.
 *
 * Reconstruction uses recorded scope identities and kernel mount reclamation,
 * never replacement acquisitions. The native services retain responsibility
 * for their own orphan reconciliation; failed scope lookup is diagnostic, not
 * evidence that a lost runtime was reaped.
 *
 * @template {{sandboxSessionId: string, workspaceMountPoint: string,
 *   mounterSocketDir: string, mounterEnv?: Record<string, string>}} Plan
 * @template Reply
 * @param {object} options
 * @param {string} options.name
 * @param {(text: string) => Plan} options.readPlan
 * @param {(plan: Plan, resolver: any, owner: ActivationOwner) => Promise<NativeClient<Reply>>} options.start
 * @param {Record<string, string>} [options.env]
 * @param {typeof reclaimRecordedMount} [options.reclaimMount]
 * @param {any} [options.context]
 * @param {(error: unknown) => void} [options.reportError]
 */
export const makeHostedSessionSupervisor = ({
  name,
  readPlan,
  start,
  env = {},
  reclaimMount = reclaimRecordedMount,
  context,
  reportError = error => console.error('Hosted session cleanup pending', error),
}) => {
  let stopping = false;
  let stopped = false;
  /** @type {string | undefined} */
  let originalText;
  /** @type {Promise<void> | undefined} */
  let activating;
  /** @type {Promise<void> | undefined} */
  let closing;
  /** @type {Map<ResourceRole, Resource>} */
  const resources = new Map();
  const assertOpen = () => {
    !stopping || Fail`${q(name)} native controller is stopping`;
  };
  /** @param {ResourceRole} role */
  const release = role => {
    const resource = resources.get(role);
    if (!resource || resource.released) return Promise.resolve();
    if (!resource.flight) {
      resource.flight = Promise.resolve()
        .then(async () => {
          const { value } = resource;
          if (role === 'client') await E(value).terminate();
          else if (role === 'broker') await E(value).revoke();
          else if (role === 'sandbox') await E(value).close();
          else await value.close();
          resource.released = true;
        })
        .catch(error => {
          resource.failed = true;
          throw error;
        });
    }
    return resource.flight;
  };
  const closeResources = async () => {
    const results = await Promise.allSettled([
      release('client'),
      release('broker'),
      release('mcp'),
      release('sandbox').then(() => release('mounter')),
    ]);
    const errors = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw AggregateError(errors, `${name} native cleanup pending`);
  };
  /** @type {ActivationOwner['own']} */
  const own = (role, value) => {
    !resources.has(role) || Fail`Native resource ${q(role)} is already owned`;
    resources.set(role, { value, released: false });
    if (stopping) {
      void closeResources().catch(reportError);
      assertOpen();
    }
    return value;
  };
  const owner = harden({ own, assertOpen });
  /**
   * @param {string} text
   * @param {any} resolver
   */
  const activate = (text, resolver) => {
    assertOpen();
    if (activating) {
      text === originalText || Fail`Native controller plan cannot change`;
      return activating;
    }
    originalText = text;
    activating = Promise.resolve().then(async () => {
      assertOpen();
      const client = await start(readPlan(text), resolver, owner);
      own('client', client);
    });
    return activating;
  };
  /**
   * @param {string} text
   * @param {any} resolver
   */
  const terminate = (text, resolver) => {
    if (originalText !== undefined) {
      text === originalText || Fail`Cleanup must use the original native plan`;
    } else {
      originalText = text;
    }
    stopping = true;
    for (const resource of resources.values()) {
      if (resource.failed) {
        resource.failed = false;
        resource.flight = undefined;
      }
    }
    if (closing) {
      // A hung owner must not prevent retrying another owner's failed
      // revocation. Keep the same final completion proof, but restart failed
      // independent releases on each explicit stop request.
      void closeResources().catch(reportError);
      return closing;
    }
    closing = (async () => {
      if (!activating) {
        const plan = readPlan(text);
        const recovered = await Promise.allSettled(
          /** @type {const} */ ([
            ['sandbox', 'sandboxService'],
            ['broker', 'brokerService'],
          ]).map(async ([role, dependency]) => {
            if (resources.has(role)) return;
            const service = await E(resolver).get(dependency);
            const value = await E(service).lookupScope(plan.sandboxSessionId);
            if (value) resources.set(role, { value, released: false });
          }),
        );
        const released = await Promise.allSettled([
          closeResources(),
          reclaimMount({ ...plan, mounterEnv: { ...env, ...plan.mounterEnv } }),
        ]);
        const failures = released.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        const diagnosed = recovered.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
          throw AggregateError(
            [...diagnosed, ...failures],
            'Original local 9P/MCP cleanup ownership is unavailable',
          );
        for (const error of diagnosed) reportError(error);
      } else {
        // Closing admitted owners may be what lets activation settle. Drain
        // it before the final sweep, which includes every late acquisition.
        await Promise.allSettled([activating, closeResources()]);
        await closeResources();
      }
      stopped = true;
    })().catch(error => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  if (context !== undefined) {
    const lost = () => {
      stopping = true;
      // Context cancellation has no resolver with which to reconstruct old
      // ownership. It fences and releases this incarnation's retained owners;
      // explicit terminate remains the completion/retry acknowledgement.
      void closeResources().catch(reportError);
    };
    void E(context).whenCancelled().then(lost, lost);
  }
  return makeExo(`${name}NativeController`, SupervisorInterface, {
    activate,
    send: async (prompt, options = {}) => {
      assertOpen();
      const client = /** @type {NativeClient<Reply> | undefined} */ (
        resources.get('client')?.value
      );
      if (client === undefined) {
        throw Fail`${q(name)} native controller is not active`;
      }
      return E(client).send(prompt, options);
    },
    interrupt: async () => {
      const client = resources.get('client')?.value;
      if (client) await E(client).interrupt();
    },
    status: async () => {
      const client = resources.get('client')?.value;
      return harden({
        ...(client ? await E(client).status() : {}),
        stopping,
        stopped,
      });
    },
    terminate,
  });
};
harden(makeHostedSessionSupervisor);
