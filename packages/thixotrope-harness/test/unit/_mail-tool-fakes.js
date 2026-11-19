// @ts-check
// Fakes for the mail and request tools' unit tests (mail-tools.test.js,
// request-tools.test.js): an Outbox, MailAddresses, SubagentHandles and
// RequestTickets made with the real guards (postOfficeTables), a stand-in
// `inbox` part with the methods of m9-interfaces.md 3.2 that the tools
// call, and a ToolContext over the real label map. AVA skips files that
// start with an underscore.
import './_m1a-prelude.js';

/* eslint-disable import/no-relative-packages */
import { postOfficeTables } from '../../guest/lib/guards/post-office.js';
import { interfaces } from '../../guest/lib/interfaces.js';
import { makeLabels } from '../../guest/session/labels.js';
import { execPart } from '../../guest/session/tools/exec.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** @type {any} */
const I = postOfficeTables().interfaces;
/** @type {any} */
const B = interfaces;

/** @param {string} title */
export const makeAddress = title =>
  makeExo('MailAddress', I.MailAddress, {
    describe: () => harden({ title, kind: 'session' }),
  });

/** @param {string} name */
export const makeHandle = name =>
  makeExo('SubagentHandle', I.SubagentHandle, {
    describe: () => harden({ name, state: 'ready', depth: 1 }),
    ask: () => harden({ text: '', edges: [] }),
    cancelAsk: () => undefined,
    stop: () => undefined,
  });

/**
 * An Outbox that records drafts; `refuse` maps a recipient object to the
 * refusal text its result carries.
 */
export const makeOutbox = () => {
  /** @type {any[]} */
  const drafts = [];
  /** @type {Map<any, string>} */
  const refuse = new Map();
  const outbox = makeExo('Outbox', I.Outbox, {
    /** @param {any} draft */
    post: draft => {
      drafts.push(draft);
      return harden({
        results: draft.to.map(
          (/** @type {any} */ to, /** @type {number} */ i) =>
            refuse.has(to)
              ? harden({ refused: refuse.get(to) })
              : harden({ postmark: 100 + i }),
        ),
      });
    },
  });
  return { outbox, drafts, refuse };
};

/**
 * A RequestTicket that records its answers; `closed` makes it refuse.
 * @param {'request' | 'form'} kind
 */
export const makeTicket = kind => {
  /** @type {any[]} */
  const calls = [];
  const state = { closed: false };
  const refuseIfClosed = () => {
    if (state.closed) throw Error('closed ticket');
  };
  const ticket = makeExo('RequestTicket', I.RequestTicket, {
    describe: () => harden({ kind, state: 'open' }),
    /** @param {any} answer */
    answer: answer => {
      refuseIfClosed();
      calls.push(['answer', answer]);
    },
    /** @param {any} values */
    submit: values => {
      refuseIfClosed();
      calls.push(['submit', values]);
    },
  });
  return { ticket, calls, state };
};

/**
 * A stand-in `inbox` part over plain message records (3.2 `InboxPart`:
 * `get`, `views`, `dismiss`, `settleRequest`).
 * @param {any[]} messages
 */
export const makeInbox = messages => {
  /** @type {Map<number, any>} */
  const byNumber = new Map(messages.map(m => [m.number, { ...m }]));
  /** @type {any[]} */
  const log = [];
  const inbox = harden({
    /** @param {number} number */
    get: number => byNumber.get(number),
    /** @param {{ limit: number }} options */
    views: ({ limit }) => {
      log.push(['views', limit]);
      return harden(
        [...byNumber.values()]
          .reverse()
          .slice(0, limit)
          .map(m => ({
            number: m.number,
            type: m.type,
            fromTitle: 'Bob',
            body: m.body ?? 'hi',
            edges: [],
            state: m.state,
            at: 1,
          })),
      );
    },
    /** @param {number} number */
    dismiss: number => {
      const message = byNumber.get(number);
      if (message.state === 'waiting') {
        return harden({ refused: `Message #${number} has not been handled` });
      }
      byNumber.delete(number);
      return harden({ ok: true });
    },
    /** @param {number} number */
    settleRequest: number => {
      const message = byNumber.get(number);
      log.push(['settleRequest', number]);
      if (message?.settled !== false) return undefined;
      message.settled = true;
      return harden({
        ticket: message.ticket,
        /** @param {boolean} sent */
        settled: sent => {
          log.push(['settled', number, sent]);
          if (!sent) message.settled = false;
        },
      });
    },
  });
  return { inbox, log, byNumber };
};

/**
 * An exec vat whose `inspect` answers are the test's (splitArgs).
 * @param {(request: any) => any} answer
 */
export const makeExecVat = answer => {
  /** @type {any[]} */
  const inspects = [];
  const scope = makeExo('ExecScope', B.ExecScope, {
    run: () => harden({ status: 'busy' }),
    abandon: () => undefined,
    /** @param {any} request */
    inspect: request => {
      inspects.push(request);
      return answer(request);
    },
  });
  const execVat = makeExo('ExecHandle', B.ExecHandle, {
    scope: () => harden({ scope, deadlineMs: 4000 }),
    retire: () => undefined,
  });
  return { execVat, inspects };
};

/**
 * A StagedText of a fresh Blob handle.
 * @param {number} bytes
 * @param {string} [preview]
 */
export const makeStaged = (bytes, preview = 'big') =>
  harden({
    blob: makeExo('Blob', B.Blob, {}),
    preview,
    bytes,
  });

/**
 * A ToolContext for the tools: services (`mail`, `operatorAddress`,
 * `execVat`) and runtime (`labels`, `inbox`, `subagents`, `exec`).
 * @param {object} options
 * @param {any} [options.outbox]
 * @param {any} [options.inbox]
 * @param {any} [options.operatorAddress]
 * @param {any} [options.execVat]
 * @param {Map<string, any>} [options.subagents]
 * @param {readonly any[]} [options.seeds]
 */
export const makeContext = ({
  outbox,
  inbox,
  operatorAddress,
  execVat,
  subagents = new Map(),
  seeds = [],
}) => {
  const labels = makeLabels({ seeds });
  const runtime = harden({
    labels,
    inbox,
    exec: execPart.make(),
    subagents: harden({
      handleOf: (/** @type {string} */ n) => subagents.get(n),
    }),
  });
  const services = harden({ mail: outbox, operatorAddress, execVat });
  return { context: harden({ services, runtime, turn: harden({}) }), labels };
};
