// @ts-check

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { isRemotable } from '@endo/pass-style';
import { M } from '@endo/patterns';

import { Fail, q } from '@endo/errors';
import { AgentDriverMakerInterface } from '../src/interfaces.js';

/**
 * Thrown by the fake daemon at an injected crash point. Once one is thrown the
 * incarnation is dead: every later call throws too, as if the process exited.
 */
export class Crash extends Error {}
harden(Crash);

/**
 * Make a method-less remotable that stands in for a daemon-held value.
 *
 * @param {string} name
 */
export const makeToken = name => makeExo(name, M.interface(name, {}), {});
harden(makeToken);

/**
 * Guest powers in the fake carry real directory verbs, so a test can tell a
 * leaked guest apart from its method-less `@self` handle.
 */
const makeGuestPowers = () =>
  makeExo('Guest', M.interface('Guest', {}, { defaultGuards: 'passable' }), {
    async lookup() {
      return makeToken('GuestValue');
    },
    async provideGuest() {
      return makeToken('Grandchild');
    },
  });

/**
 * @typedef {object} Formula
 * @property {string} id
 * @property {string} type
 * @property {any} value
 * @property {string} [powers]
 * @property {Map<string, string>} [names] - Present for guests.
 * @property {boolean} [cancelled]
 * @property {number} incarnations
 */

/**
 * An in-memory stand-in for the daemon: formulas with identifiers, a private
 * directory of names, guests that are themselves directories, and
 * `provideGuest` / `makeUnconfined` with the daemon's real adoption behavior.
 * State survives `restart()`; only the incarnation dies at a crash.
 */
export const makeFakeDaemon = () => {
  /** @type {Map<string, Formula>} */
  const formulas = new Map();
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {Map<string, any>} */
  const plain = new Map();
  let nextId = 1;
  let effects = 0;
  let crashAt = Infinity;
  let dead = false;
  /** @type {string[]} */
  const trace = [];

  /** @param {string} label */
  const effect = label => {
    if (dead) throw new Crash(`dead incarnation (${label})`);
    effects += 1;
    trace.push(label);
    if (effects === crashAt) {
      dead = true;
      throw new Crash(`crash at ${label}`);
    }
  };
  const alive = () => {
    if (dead) throw new Crash('dead incarnation');
  };

  /**
   * @param {string} type
   * @param {any} value
   * @param {Partial<Formula>} [extra]
   */
  const formulate = (type, value, extra = {}) => {
    const id = `${nextId}:fake`;
    nextId += 1;
    /** @type {Formula} */
    const formula = { id, type, value, incarnations: 0, ...extra };
    formulas.set(id, formula);
    return formula;
  };

  /** @param {any} value */
  const idOfValue = value => {
    for (const formula of formulas.values()) {
      if (formula.value === value) return formula.id;
    }
    return formulate('value', value).id;
  };

  /**
   * Resolve a path to the directory map that holds its last segment.
   *
   * @param {string[]} path
   */
  const directoryFor = path => {
    if (path.length === 1) return names;
    path.length === 2 || Fail`Fake daemon paths have at most two segments`;
    const guestId = names.get(path[0]);
    const guest = guestId ? formulas.get(guestId) : undefined;
    if (!guest || !guest.names) throw Fail`${q(path[0])} is not a guest`;
    return guest.names;
  };

  /** @param {string[]} path */
  const idAt = path => {
    const directory = directoryFor(path);
    return directory.get(path[path.length - 1]);
  };

  /** @param {string} id */
  const incarnate = id => {
    const formula = formulas.get(id) || Fail`no formula ${q(id)}`;
    if (formula.type === 'unconfined' && !formula.cancelled) {
      formula.incarnations += 1;
    }
    return formula.value;
  };

  const makeGuestFormula = () => {
    const handle = makeToken('Handle');
    const handleFormula = formulate('handle', handle);
    const pinsFormula = formulate('pins', makeToken('Pins'));
    const guest = makeGuestPowers();
    const formula = formulate('guest', guest, {
      names: new Map([
        ['@self', handleFormula.id],
        ['@pins', pinsFormula.id],
      ]),
    });
    return formula;
  };

  /** The coordinator's private host, the `PrivateHost` port. */
  const host = makeExo(
    'PrivateHost',
    M.interface('PrivateHost', {}, { defaultGuards: 'passable' }),
    {
      /** @param {string[]} path */
      async has(...path) {
        alive();
        return idAt(path) !== undefined;
      },
      /** @param {string[]} path */
      async lookup(...path) {
        alive();
        const id = idAt(path);
        if (id === undefined) throw Fail`unknown name ${q(path)}`;
        if (plain.has(id)) return plain.get(id);
        return incarnate(id);
      },
      /** @param {string[]} path */
      async list(...path) {
        alive();
        if (path.length === 0) return [...names.keys()].sort();
        const guestId = names.get(path[0]);
        const guest = guestId ? formulas.get(guestId) : undefined;
        if (!guest || !guest.names) throw Fail`not a guest`;
        return [...guest.names.keys()].sort();
      },
      /** @param {string[]} path */
      async identify(...path) {
        alive();
        return idAt(path);
      },
      /** @param {string[]} path */
      async formulaType(...path) {
        alive();
        const id = idAt(path);
        return id === undefined ? undefined : formulas.get(id)?.type;
      },
      /** @param {string[]} path */
      async powersOf(...path) {
        alive();
        const id = idAt(path);
        return id === undefined ? undefined : formulas.get(id)?.powers;
      },
      /**
       * @param {any} value
       * @param {string | string[]} nameOrPath
       */
      async storeValue(value, nameOrPath) {
        const path = typeof nameOrPath === 'string' ? [nameOrPath] : nameOrPath;
        effect(`store ${path.join('/')}`);
        const directory = directoryFor(path);
        const isRecord =
          value !== null && typeof value === 'object' && !isRemotable(value);
        let id;
        if (isRecord) {
          id = `${nextId}:data`;
          nextId += 1;
          plain.set(id, value);
        } else {
          id = idOfValue(value);
        }
        directory.set(path[path.length - 1], id);
      },
      /** @param {string[]} path */
      async remove(...path) {
        effect(`remove ${path.join('/')}`);
        directoryFor(path).delete(path[path.length - 1]);
      },
      /** @param {string[]} path */
      async cancel(...path) {
        effect(`cancel ${path.join('/')}`);
        const id = idAt(path);
        if (id === undefined) return;
        cancelFormula(id);
      },
      /**
       * `provideGuest` returns whatever the name holds, of any type.
       *
       * @param {string} name
       */
      async provideGuest(name) {
        alive();
        const existing = names.get(name);
        if (existing !== undefined) return incarnate(existing);
        const formula = makeGuestFormula();
        effect(`formulate guest ${name}`);
        names.set(name, formula.id);
        effect(`name guest ${name}`);
        return formula.value;
      },
    },
  );

  /** @param {string} id */
  const cancelFormula = id => {
    const formula = formulas.get(id);
    if (!formula || formula.cancelled) return;
    formula.cancelled = true;
    for (const dependent of formulas.values()) {
      if (dependent.powers === id) cancelFormula(dependent.id);
    }
  };

  /**
   * The daemon's `makeUnconfined`: always formulates a new caplet, with no
   * adoption path, then (optionally) writes the result name.
   *
   * @param {any} powers
   */
  const makeUnconfined = powers => {
    alive();
    const powersId = idOfValue(powers);
    const responder = makeToken('Responder');
    const formula = formulate('unconfined', responder, { powers: powersId });
    effect('formulate responder');
    return formula;
  };

  /**
   * A maker that formulates a responder over the driver guest, as Fae's
   * `makeUnconfined(..., { powersName })` drivers do.
   */
  const makeMaker = () => {
    /** @type {any[]} */
    const calls = [];
    const maker = makeExo('AgentDriverMaker', AgentDriverMakerInterface, {
      async installDriver(/** @type {any} */ context) {
        calls.push(context);
        const formula = makeUnconfined(context.driverGuest);
        return harden({ responder: formula.value });
      },
    });
    return { maker, calls };
  };

  return {
    host,
    makeMaker,
    restart: () => {
      dead = false;
      crashAt = Infinity;
    },
    /** @param {number} n - Crash at the n-th effect from now. */
    crashAfter: n => {
      crashAt = effects + n;
    },
    get effects() {
      return effects;
    },
    trace,
    formulas,
    names,
    /** @param {string} name */
    formulaAt: name => {
      const id = names.get(name);
      return id === undefined ? undefined : formulas.get(id);
    },
    /** Running unconfined caplets: incarnated and not cancelled. */
    running: () =>
      [...formulas.values()].filter(
        f => f.type === 'unconfined' && !f.cancelled && f.incarnations > 0,
      ),
    unconfined: () =>
      [...formulas.values()].filter(f => f.type === 'unconfined'),
    /**
     * Simulate a daemon restart: incarnations are forgotten, durable state
     * stays.
     */
    forgetIncarnations: () => {
      for (const formula of formulas.values()) formula.incarnations = 0;
    },
    /**
     * Write directly into a guest's directory, as the guest itself could.
     *
     * @param {string} guestName
     * @param {string} petName
     * @param {any} value
     */
    guestWrite: (guestName, petName, value) => {
      const formula = formulas.get(
        /** @type {string} */ (names.get(guestName)),
      );
      if (!formula || !formula.names) throw Fail`not a guest`;
      formula.names.set(petName, idOfValue(value));
    },
    /**
     * Delete a name from a guest's directory, as the guest itself could.
     *
     * @param {string} guestName
     * @param {string} petName
     */
    guestDelete: (guestName, petName) => {
      const formula = formulas.get(
        /** @type {string} */ (names.get(guestName)),
      );
      if (!formula || !formula.names) throw Fail`not a guest`;
      formula.names.delete(petName);
    },
    /** @param {string} name */
    plainAt: name => plain.get(/** @type {string} */ (names.get(name))),
    makeGuestFormula,
  };
};
harden(makeFakeDaemon);
