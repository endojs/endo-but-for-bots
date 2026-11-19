// @ts-check
/**
 * The factory vat program (M1a W1a.6; architecture 3.1;
 * `designs/m1a-interfaces.md` sections 3.4 and 9).
 *
 * Installed once as the application `harness`:
 *
 *   client.call('install', 'harness', <bundle of this module>,
 *     [['host', 'agentHostAdmin'], ['vats', 'vats']])
 *
 * `make({ host, vats })` runs once, in the install; its value, the
 * `HarnessRoot`, lives in this vat's heap from then on (orthogonal
 * persistence: there is no re-make at restart). `make` registers the
 * factory's start listener with the agent-host manager, whose
 * `lifecycle.started()` calls it at every daemon start (D-5).
 *
 * M1b (W1b.5): the factory also holds the spare pool (`pool.js`, with the
 * exec program's store and the pool settings) and the session list feed
 * (`list-feed.js`), which the row table tells of every row change. `make`
 * fetches the first list publisher; the start listener fetches it again at
 * every start.
 *
 * Guest rules: prelude globals only.
 */
import { makeFactoryKit, stagingSources } from './factory.js';
import { makeListFeed } from './list-feed.js';
import { makePool, makePoolSettings } from './pool.js';
import {
  makeHarnessRoot,
  makeHarnessSettings,
  makeProgramStore,
} from './root.js';
import { makeRowTable } from './rows.js';
import { makeStartCount } from './starts.js';
import { messageOf, previewText } from '../lib/bounded.js';
import { limits } from '../lib/limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ListFeed } from './list-feed.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} powers
 * @param {any} powers.host the AgentHostAdmin
 * @param {any} powers.vats the worker controller
 */
export const make = ({ host, vats }) => {
  /** @type {{ feed: ListFeed | undefined }} */
  const late = { feed: undefined };
  const rows = makeRowTable({
    onChange: (row, kind) => {
      if (kind === 'removed') late.feed?.removed(row);
      else late.feed?.changed(row);
    },
    rev: () => late.feed?.rev() ?? 0,
  });
  const listFeed = makeListFeed({
    admin: host,
    listed: rows.listed,
    isListed: rows.isListed,
  });
  late.feed = listFeed;
  const programs = makeProgramStore();
  const execPrograms = makeProgramStore({ what: 'exec program' });
  const settings = makePoolSettings();
  // M2 W2.7: backends, default backend and model, turn deadline.
  const harnessSettings = makeHarnessSettings({
    pool: () => ({
      spareSessions: settings.spareSessions(),
      spareExec: settings.spareExec(),
      execDeadlineMs: settings.execDeadlineMs(),
    }),
  });
  // One count of daemon starts for the factory, the pool and the delete
  // records (HR-SYN-36).
  const starts = makeStartCount();
  const pool = makePool({
    vats,
    programs: { session: programs, exec: execPrograms },
    settings,
    sessionSources: stagingSources,
    mintHost: () => E(host).forSession(),
    starts,
  });
  const kit = makeFactoryKit({
    admin: host,
    vats,
    programs,
    rows,
    pool,
    settings,
    listFeed,
    harnessSettings,
    starts,
  });
  void listFeed.refresh();
  // The Registration is kept for the vat's life. A failure leaves the
  // factory without restart recovery: `status()` reports it (HR-GUEST-12);
  // the provisioning test checks that a restart reaches the listener.
  /** @type {{ registration: any, failure: string | undefined }} */
  const held = { registration: undefined, failure: undefined };
  E(host)
    .onStart(kit.startListener)
    .then(
      (/** @type {any} */ value) => {
        held.registration = value;
      },
      (/** @type {unknown} */ error) => {
        held.failure = previewText(messageOf(error), limits.reasonUnits);
      },
    );
  return makeHarnessRoot({
    operator: kit.operator,
    rows,
    programs,
    execPrograms,
    pool,
    settings: harnessSettings,
    exports: kit.exports,
    configureSpeech: kit.configureSpeech,
    startListenerFailure: () => held.failure,
  });
};
harden(make);
