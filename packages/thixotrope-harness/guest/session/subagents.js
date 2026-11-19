// @ts-check
/**
 * The `subagents` runtime part (designs/m9-interfaces.md 3.2, D-M9-10,
 * D-M9-16, D-M9-22): the parent's side of its children. It holds
 *
 * - the name -> `SubagentHandle` map (the model names a child by the name
 *   it gave at spawn; `subagents/<name>` in an attachment or recipient list
 *   is resolved here, never in the label map, D-M9-23). It is bounded by
 *   the factory's tree limit (a parent holds a `Delegation` only below the
 *   depth limit, and `spawn` admits at most `maxDescendants` per tree) and
 *   shrinks at `stop`; after a recovery it is replaced by
 *   `Delegation.children()` (`resync`);
 * - the names whose `spawn` is out, so two spawns of one name in a round
 *   cannot both pass the uniqueness check (at most `callWindow` per turn;
 *   a recovered turn's are dropped);
 * - the open asks, one per child (Fae: one question in flight), in the
 *   shared per-part call table (`tools/call-table.js`, D-M9-22): the first
 *   ending wins (the answer, the deadline, the turn's cancel or its
 *   recovery) and a late answer of an abandoned generation is ignored;
 * - the claim time of the current turn (`TurnStarted.at`), the only clock a
 *   tool can read (a vat has none, architecture 12.1): the `at` of a spawn
 *   or ask request.
 *
 * Hooks: `onClaim` reads the claim time (no send). `onCancel` settles the
 * turn's open asks with `mailTexts.askAbandoned` and tells each child's
 * handle `cancelAsk` (sendOnly). `onRecover` sends `cancelAsk` for the
 * recovered turn's open asks and ends them quietly (recovery already
 * recorded the outcome-unknown result, D-M9-16), drops its spawns in
 * flight, and re-reads the children when the part holds or was making any:
 * a session that never delegated sends nothing (no message on a turn that
 * does not use subagents).
 *
 * Nothing here is exported with the session (D-M9-21): an imported row has
 * a `Delegation` of its own and no children. Guest rules.
 */
import { mailTexts, mailTextOf } from '../lib/guards/mail.js';
import { texts } from '../lib/guards/session.js';
import { makeCallTable } from './tools/call-table.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { HookTurn } from './runtime-parts.js' */
/** @import { CallEntry } from './tools/call-table.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/**
 * @typedef {object} OpenAsk
 * @property {string} name the child's name
 * @property {any} handle the SubagentHandle the ask went to
 * @property {number} seconds the ask's timeout
 * @property {CallEntry} entry its call-table entry
 */

/**
 * @typedef {object} AskCall the `ToolContext` fields an ask is opened with
 * @property {string} opId
 * @property {any} turn
 * @property {number} generation
 * @property {any} [endpoint] the turn's Endpoint: the deadline is armed
 *   there (and disarmed at an ending other than the deadline)
 * @property {number} seconds
 */

export const subagentsPart = harden({
  name: /** @type {const} */ ('subagents'),
  /** @param {{ services: any }} runtime */
  make: runtime => {
    /** @type {Map<string, any>} name -> SubagentHandle */
    const handles = new Map();
    /** @type {Map<string, any>} name -> the Turn whose spawn is out */
    const spawning = new Map();
    /** @type {Map<string, OpenAsk>} op id -> open ask */
    const asks = new Map();
    const calls = makeCallTable();
    let at = 0;

    const delegation = () => runtime.services?.subagents;

    /**
     * The open asks of one turn, after telling each child to stop.
     * @param {any} turn
     */
    const cancelAsks = turn => {
      let n = 0;
      for (const ask of asks.values()) {
        if (ask.entry.turn === turn) {
          E.sendOnly(ask.handle).cancelAsk();
          n += 1;
        }
      }
      return n;
    };

    /** Replace the map with the factory's list (after a recovery). */
    const resync = () => {
      const held = delegation();
      if (held === undefined) return Promise.resolve();
      return E(held)
        .children()
        .then(list => {
          handles.clear();
          for (const { name, handle } of list) handles.set(name, handle);
        });
    };

    return harden({
      /** The session holds a `Delegation` (below the depth limit, R4-69). */
      available: () => delegation() !== undefined,
      delegation,
      /** The claim time of the current turn (spawn and ask `at`). */
      at: () => at,
      /** @param {string} name */
      handleOf: name => handles.get(name),
      /**
       * Whether `name` is held or being spawned (the uniqueness check).
       * @param {string} name
       */
      taken: name => handles.has(name) || spawning.has(name),
      /**
       * A spawn of `name` is out for this turn.
       * @param {string} name
       * @param {any} turn
       */
      spawning: (name, turn) => {
        spawning.set(name, turn);
      },
      /**
       * The spawn answered: bind its handle (unless a resync already did),
       * or, with no handle, give the name back.
       * @param {string} name
       * @param {any} [handle]
       */
      spawned: (name, handle) => {
        spawning.delete(name);
        if (handle !== undefined && !handles.has(name))
          handles.set(name, handle);
      },
      /** @param {string} name */
      unbind: name => {
        handles.delete(name);
      },
      /**
       * Open an ask of `name` (one per child) and arm its deadline on the
       * turn's endpoint, as the exec tool arms its own.
       * @param {string} name
       * @param {AskCall} call
       * @returns {{ entry: CallEntry, handle: any } | { refused: string }}
       */
      openAsk: (name, { opId, turn, generation, endpoint, seconds }) => {
        const handle = handles.get(name);
        if (handle === undefined)
          return { refused: mailTextOf.noSubagent(name) };
        for (const ask of asks.values()) {
          if (ask.name === name)
            return { refused: mailTextOf.askInFlight(name) };
        }
        const entry = calls.open({
          opId,
          turn,
          generation,
          onEnd: (_outcome, quiet) => {
            asks.delete(opId);
            if (!quiet && endpoint !== undefined)
              E.sendOnly(endpoint).disarm(harden({ turn, opId }));
          },
        });
        // The table holds `callWindow` calls, as many as a turn issues at
        // once, so only a repeated op id finds it closed.
        if (entry === undefined)
          return { refused: mailTextOf.askInFlight(name) };
        asks.set(opId, { name, handle, seconds, entry });
        if (endpoint !== undefined)
          E.sendOnly(endpoint).armDeadline(
            harden({ turn, opId, ms: seconds * 1000 }),
          );
        return { entry, handle };
      },
      /**
       * The ask's answer (ignored when the ask ended first).
       * @param {string} opId
       * @param {number} generation
       * @param {any} outcome
       */
      closeAsk: (opId, generation, outcome) =>
        calls.answer(opId, generation, outcome),
      /**
       * The ask's deadline fired (`askSubagent`'s `deadline` entry): the
       * child is told, the ask ends with `askTimeout` (quiet: nothing to
       * disarm). False when no open ask of this turn has the op id.
       * @param {string} opId
       * @param {any} turn
       */
      timeout: (opId, turn) => {
        const ask = asks.get(opId);
        if (ask === undefined || ask.entry.turn !== turn) return false;
        E.sendOnly(ask.handle).cancelAsk();
        return calls.end(
          ask.entry,
          failed(mailTextOf.askTimeout(ask.name, ask.seconds)),
          true,
        );
      },
      resync,
      hooks: harden({
        /** @param {HookTurn} turn */
        onClaim: turn => {
          at = turn.active.claimAt;
        },
        /** @param {HookTurn} turn */
        onCancel: turn => {
          const of = turn.active.turn;
          if (cancelAsks(of) > 0)
            calls.endTurn(of, failed(mailTexts.askAbandoned), false);
        },
        /** @param {HookTurn} turn recovery recorded the unknown results */
        onRecover: turn => {
          const of = turn.active.turn;
          // A spawn cut off may have made its child (KM10): re-read too.
          const held = handles.size + spawning.size;
          cancelAsks(of);
          calls.endTurn(of, failed(texts.toolOutcomeUnknown), true);
          for (const [name, by] of spawning) {
            if (by === of) spawning.delete(name);
          }
          return held > 0 ? resync() : undefined;
        },
      }),
    });
  },
});
