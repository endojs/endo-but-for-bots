// @ts-check

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const nameRefused = () =>
  makeError(X`Agent operation failed: ${q('powers-name-refused')}`);

/**
 * Special names reach daemon authority a harness never holds: `@host` is the
 * root host's handle here, and `@endo` and `@secrets` are what this facet
 * exists to withhold.
 *
 * @param {unknown} name
 */
const assertOwnName = name => {
  const segments = Array.isArray(name) ? name : [name];
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.startsWith('@')) {
      throw nameRefused();
    }
  }
};

/**
 * For each method, the positions of arguments that are pet names or paths.
 * `send` and `reply` also carry an array of pet names to attach; a name in any
 * of those positions is checked the same way. `list`, `has`, and `remove` take
 * a variadic name path, so every argument they receive is checked.
 *
 * @type {Record<string, { names?: number[], nameLists?: number[], restNames?: boolean }>}
 */
const METHOD_ARGUMENTS = harden({
  list: { restNames: true },
  has: { restNames: true },
  lookup: { names: [0] },
  move: { names: [0, 1] },
  remove: { restNames: true },
  followMessages: {},
  listMessages: {},
  messageHistory: {},
  send: { names: [0], nameLists: [3] },
  reply: { nameLists: [3] },
  dismiss: {},
  adopt: { names: [2] },
  request: { names: [0, 2] },
  form: { names: [0, 3] },
  define: {},
  submit: {},
  resolve: { names: [1] },
  reject: {},
});

const MAILBOX_AND_NAMES = harden([
  'list',
  'has',
  'lookup',
  'move',
  'remove',
  'followMessages',
  'listMessages',
  'messageHistory',
  'send',
  'reply',
  'dismiss',
  'adopt',
]);

const MEDIATION = harden([
  'request',
  'form',
  'define',
  'submit',
  'resolve',
  'reject',
]);

/**
 * The exact guest methods each harness receives. Both may `adopt`, which keeps
 * a capability sent by mail under a pet name. Lal's tool list stays fixed
 * regardless; only Fae's driver turns an adopted capability into a tool. A
 * method outside its list is not on the facet at all, rather than checked at
 * call time.
 */
export const AGENT_POWERS_PROFILES = harden({
  lal: harden([...MAILBOX_AND_NAMES, ...MEDIATION]),
  fae: MAILBOX_AND_NAMES,
});

/**
 * Attenuate one dedicated guest to a harness's profile. It takes the guest as
 * a capability; nothing in the facet accepts a formula id or locator, so a
 * caller cannot redirect it to another guest.
 *
 * @param {any} guest
 * @param {string} harness
 */
export const makeAgentGuestPowers = (guest, harness) => {
  const profile = AGENT_POWERS_PROFILES[harness];
  if (profile === undefined) {
    throw makeError(X`Agent operation failed: ${q('invalid-harness')}`);
  }
  /** @type {Record<string, any>} */
  const guards = {};
  /** @type {Record<string, any>} */
  const methods = {};
  for (const method of profile) {
    const {
      names = [],
      nameLists = [],
      restNames = false,
    } = METHOD_ARGUMENTS[method];
    guards[method] = M.callWhen().rest(M.any()).returns(M.any());
    methods[method] = async (...callArguments) => {
      await null;
      if (restNames) {
        for (const name of callArguments) assertOwnName(name);
      }
      for (const position of names) {
        if (callArguments[position] !== undefined)
          assertOwnName(callArguments[position]);
      }
      for (const position of nameLists) {
        for (const name of callArguments[position] || []) assertOwnName(name);
      }
      const result = await E(guest)[method](...callArguments);
      return method === 'list'
        ? harden(result.filter(name => !name.startsWith('@')))
        : result;
    };
  }
  return makeExo(
    `AgentGuestPowers:${harness}`,
    M.interface(`AgentGuestPowers:${harness}`, guards),
    methods,
  );
};
harden(makeAgentGuestPowers);
