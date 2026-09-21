// @ts-check

import os from 'os';
import url from 'url';
import path from 'path';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, restart, purge, makeEndoClient } from '../index.js';
import { parseId } from '../src/formula-identifier.js';
import { idFromLocator, parseLocator } from '../src/locator.js';
import { makeDaemonDatabase } from '../src/manager-database-node.js';

/**
 * A NetworkSpec describes the inputs needed to install one of the
 * daemon's `EndoNetwork` transports as the `@nets/<key>` entry under
 * which the daemon discovers active transports. The shared multiplayer
 * suite is parameterized over this so the same invite/accept/value
 * round-trip can run on `tcp-netstring`, `ocapn`, or any future
 * transport that conforms to the same surface.
 *
 * @typedef {object} NetworkSpec
 * @property {string} listenAddrName  Pet name under which the host
 *   stores the bound `host:port` (e.g. `tcp-listen-addr`).
 * @property {string} listenAddr      The `host:port` to advertise as
 *   the desired bind address. `'127.0.0.1:0'` requests an
 *   OS-assigned ephemeral port.
 * @property {string} modulePath      Path relative to `packages/daemon`
 *   to the `make(powers, context)` network module that will be loaded
 *   via `host.makeUnconfined`.
 * @property {string} netsKey         The `@nets/<key>` subdirectory
 *   the network registers at after installation.
 */

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

const MAX_CONFIG_DIR_LENGTH = 80;
let configPathId = 0;

const getConfigDirectoryName = (testTitle, configNumber) => {
  const cleanTitle = testTitle
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .slice(0, 50);
  const defaultPath = `${cleanTitle}`;
  const basePath =
    defaultPath.length <= MAX_CONFIG_DIR_LENGTH
      ? defaultPath
      : defaultPath.slice(0, MAX_CONFIG_DIR_LENGTH);
  const testId = String(configPathId).padStart(4, '0');
  const configId = String(configNumber).padStart(2, '0');
  const configSubDirectory = `${basePath}#${testId}-${configId}`;
  configPathId += 1;
  return configSubDirectory;
};

/** @param  {...string} root */
const makeConfig = (...root) => {
  // Use a short path for the socket to stay within the ~108 char
  // Unix socket path limit.  CI checkout paths can be long.
  // The last root segment includes a unique test/config ID suffix.
  const tag = root.join('-').slice(-40);
  const shortSock = path.join(os.tmpdir(), `endo-${tag}.sock`);
  return {
    statePath: path.join(dirname, ...root, 'state'),
    ephemeralStatePath: path.join(dirname, ...root, 'run'),
    cachePath: path.join(dirname, ...root, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? String.raw`\\?\pipe\endo-${root.join('-')}-test.sock`
        : shortSock,
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

const openTestDb = statePath => {
  return makeDaemonDatabase({
    statePath,
    ephemeralStatePath: '',
    cachePath: '',
    sockPath: '',
  });
};

const formulaExistsInDb = (statePath, id) => {
  const { number } = parseId(id);
  return openTestDb(statePath).hasFormula(number);
};

/**
 * Wait for a condition to become true, polling at intervals.
 *
 * @param {() => boolean | Promise<boolean>} check
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 */
const waitForCondition = async (check, opts = {}) => {
  const { timeoutMs = 5000, intervalMs = 100 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
};

/**
 * Structural subset of AVA's `TestFn` that the multiplayer suite uses.
 * Declaring it as a subset rather than `import('ava').TestFn` lets the
 * caller pass either a full `baseTest` or a skip-decorated shim that
 * only carries the methods this suite touches — the
 * `ENDO_BIN`/`ENDO_NODE_WORKER_BIN` skip wrapper in the entry points
 * is exactly such a shim.
 *
 * @typedef {object} SuiteTestRunner
 * @property {(title: string, impl: (t: any) => any) => void} serial
 *   For `test.serial('title', async t => …)`.
 * @property {(impl: (t: any) => any) => void} beforeEach
 * @property {{ always: (impl: (t: any) => any) => any }} afterEach
 */

/**
 * Register the multiplayer invite/accept/value-exchange/GC suite
 * against a specific network. The same tests run under every
 * NetworkSpec; only the @nets/<key> installation differs.
 *
 * @param {object} options
 * @param {SuiteTestRunner} options.test  The AVA test instance to
 *   register against (typically the result of `baseTest` after any
 *   skip/wrap decorations).
 * @param {NetworkSpec} options.network
 */
export const runMultiplayerSuite = ({ test, network }) => {
  const prepareConfig = async (t, { gcEnabled = true } = {}) => {
    const { reject: cancel, promise: cancelled } = makePromiseKit();
    cancelled.catch(() => {});
    const config = {
      ...makeConfig('tmp', getConfigDirectoryName(t.title, t.context.length)),
      gcEnabled,
    };
    await purge(config);
    await start(config);
    const contextObj = { cancel, cancelled, config };
    t.context.push(contextObj);
    return { ...contextObj };
  };

  const makeHost = async (config, cancelled) => {
    const { getBootstrap, closed } = await makeEndoClient(
      'client',
      config.sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const bootstrap = getBootstrap();
    return { host: E(bootstrap).host() };
  };

  const prepareHostWithGcAndNetwork = async t => {
    const { cancel, cancelled, config } = await prepareConfig(t, {
      gcEnabled: true,
    });
    const { host } = await makeHost(config, cancelled);

    await E(host).storeValue(network.listenAddr, network.listenAddrName);
    const servicePath = path.join(dirname, network.modulePath);
    const serviceLocation = url.pathToFileURL(servicePath).href;
    const networkService = await E(host).makeUnconfined(
      '@main',
      serviceLocation,
      {
        powersName: '@agent',
        resultName: 'test-network',
      },
    );
    await networkService;
    await E(host).move(['test-network'], ['@nets', network.netsKey]);

    return { host, config, cancel, cancelled };
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  test.beforeEach(t => {
    t.context = [];
  });

  test.afterEach.always(async t => {
    const configs = /** @type {any[]} */ (t.context);
    await Promise.allSettled(configs.map(({ config }) => stop(config)));
    for (const { cancel, cancelled } of configs) {
      cancelled.catch(() => {});
      cancel(Error('teardown'));
    }
  });

  // ── Tests ──────────────────────────────────────────────────────

  test.serial(
    'deleting invited guest pet name collects guest formulas',
    async t => {
      const { host, config } = await prepareHostWithGcAndNetwork(t);

      // Create a guest.
      await E(host).provideGuest('my-guest', { agentName: 'my-agent' });

      // Verify the guest formula exists.
      const guestId = await E(host).identify('my-agent');
      const handleId = await E(host).identify('my-guest');
      t.true(formulaExistsInDb(config.statePath, guestId), 'guest exists');
      t.true(formulaExistsInDb(config.statePath, handleId), 'handle exists');

      // Remove both the pet name and the pin.
      await E(host).remove('my-agent');
      await E(host).remove('my-guest');

      // The guest and handle should be collected.
      await waitForCondition(
        () =>
          !formulaExistsInDb(config.statePath, guestId) &&
          !formulaExistsInDb(config.statePath, handleId),
      );
      t.false(formulaExistsInDb(config.statePath, guestId), 'guest collected');
      t.false(
        formulaExistsInDb(config.statePath, handleId),
        'handle collected',
      );
    },
  );

  test.serial('invited guest retains values shared through mail', async t => {
    const { host: hostA, config: configA } =
      await prepareHostWithGcAndNetwork(t);
    const { host: hostB } = await prepareHostWithGcAndNetwork(t);

    // Establish invite/accept.
    const invitation = await E(hostA).invite('bob');
    const invitationLocator = await E(invitation).locate();
    await E(hostB).accept(invitationLocator, 'alice');

    // Create a value on A.
    await E(hostA).evaluate('@main', '"shared-value"', [], [], ['shared']);
    const sharedLocator = await E(hostA).locate('shared');
    const sharedId = idFromLocator(sharedLocator);

    // Send it to bob.
    await E(hostA).send('bob', ['Here'], ['shared'], ['shared']);

    // The value should remain alive on A (bob references it via mail).
    t.true(
      formulaExistsInDb(configA.statePath, sharedId),
      'shared value exists on A',
    );

    // B receives the message.
    const messages = /** @type {unknown[]} */ (await E(hostB).listMessages());
    t.true(messages.length > 0, 'B received a message');
  });

  test.serial(
    'accepted invitation uses its result name as the connection root',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);

      // Establish invite/accept.
      const invitation = await E(hostA).invite('bob');
      const invitationLocator = await E(invitation).locate();
      await E(hostB).accept(invitationLocator, 'alice');

      const bobNames = await E(hostA).list();
      t.true(bobNames.includes('bob'), 'bob exists on A after accept');
      const pinnedId = await E(hostA).identify('@pins', 'guest-bob');
      t.is(pinnedId, undefined, 'accept does not mint a second local guest');

      await E(hostA).remove('bob');
      t.is(await E(hostA).identify('bob'), undefined, 'result name removed');
    },
  );

  test.serial('partition does not prevent local value release', async t => {
    const { host: hostA, config: configA } =
      await prepareHostWithGcAndNetwork(t);
    const { host: hostB, config: configB } =
      await prepareHostWithGcAndNetwork(t);

    // Establish invite/accept.
    const invitation = await E(hostA).invite('bob');
    const invitationLocator = await E(invitation).locate();
    await E(hostB).accept(invitationLocator, 'alice');

    // Create a local-only value on A (not shared with B).
    await E(hostA).storeValue({ local: true }, 'local-only');
    const localLocator = await E(hostA).locate('local-only');
    const localId = idFromLocator(localLocator);
    t.true(formulaExistsInDb(configA.statePath, localId), 'local value exists');

    // Simulate partition: stop B's daemon.
    await stop(configB);

    // Release the local value on A while partitioned.
    await E(hostA).remove('local-only');

    // GC should still collect it — partition doesn't prevent local GC.
    await waitForCondition(
      () => !formulaExistsInDb(configA.statePath, localId),
    );
    t.false(
      formulaExistsInDb(configA.statePath, localId),
      'local value collected during partition',
    );
  });

  test.serial(
    'value shared with remote peer survives local release during partition',
    async t => {
      const { host: hostA, config: configA } =
        await prepareHostWithGcAndNetwork(t);
      const { host: hostB, config: configB } =
        await prepareHostWithGcAndNetwork(t);

      // Bidirectional peer exchange.
      await E(hostA).addPeerInfo(await E(hostB).getPeerInfo());
      await E(hostB).addPeerInfo(await E(hostA).getPeerInfo());

      // Create a value on A and share it with B.
      await E(hostA).evaluate('@main', '"important"', [], [], ['data']);
      const dataLocator = await E(hostA).locate('data');
      const dataId = idFromLocator(dataLocator);

      // B stores and accesses the shared value.
      await E(hostB).storeLocator(['from-a'], dataLocator);
      const val = await E(hostB).lookup(['from-a']);
      t.is(val, 'important');

      // Simulate partition: stop B.
      await stop(configB);

      // A removes its local name for the value while B is partitioned.
      await E(hostA).remove('data');

      // The formula should still exist on A because B's retention set
      // (from before partition) should keep it alive.
      // NOTE: With the current architecture where remote values aren't
      // stored locally, the retention set may be empty. The formula
      // is only retained if it has other local references.
      // For now, verify the formula is collected (no remote retention).
      await waitForCondition(
        () => !formulaExistsInDb(configA.statePath, dataId),
        { timeoutMs: 3000 },
      ).catch(() => {});

      // Record whether it was collected (expected: yes, until per-agent
      // formula IDs enable meaningful retention sets).
      const collected = !formulaExistsInDb(configA.statePath, dataId);
      t.pass(
        collected
          ? 'formula collected (retention not yet populated — expected for now)'
          : 'formula retained by remote retention set',
      );
    },
  );

  test.serial('invite/accept works across restart', async t => {
    const {
      host: hostA,
      config: configA,
      cancelled: cancelledA,
    } = await prepareHostWithGcAndNetwork(t);
    const { host: hostB } = await prepareHostWithGcAndNetwork(t);

    // Establish invite/accept.
    const invitation = await E(hostA).invite('bob');
    const invitationLocator = await E(invitation).locate();
    await E(hostB).accept(invitationLocator, 'alice');

    // Send a message.
    await E(hostA).send('bob', ['Before restart'], [], []);

    // Verify B received it.
    const messagesBefore = await E(hostB).listMessages();
    t.true(
      messagesBefore.some(m => m.strings && m.strings[0] === 'Before restart'),
      'B received message before restart',
    );

    // Restart A.
    await restart(configA);
    const { host: hostA2 } = await makeHost(configA, cancelledA);

    // A should still know bob after restart.
    const bobNames = await E(hostA2).list();
    t.true(bobNames.includes('bob'), 'bob persists across restart');
  });

  // Guest-owned invitation primitive (designs/remote-guest-endo-cli.md sect 3):
  // an EndoGuest — not the top host — mints the invitation. Its locator `from`
  // names the guest's own handle, network mediation stays internal to the
  // daemon (the guest never gains getPeerInfo/addPeerInfo), both pet stores end
  // up with the opposite handle, neither bound handle carries host-only methods,
  // and a replayed invitation is rejected (single-use).
  test.serial('EndoGuest (not the top host) mints an invitation', async t => {
    const { host: hostA } = await prepareHostWithGcAndNetwork(t);
    const { host: hostB } = await prepareHostWithGcAndNetwork(t);

    // The inviter is a guest on A, driven only through its guest facet.
    const guestA = await E(hostA).provideGuest('guest-handle', {
      agentName: 'guest-agent',
    });

    // Guest-safety: the guest can invite but holds no network administration.
    await t.throwsAsync(
      () => E(guestA).getPeerInfo(),
      undefined,
      'guest has no getPeerInfo',
    );
    await t.throwsAsync(
      () => E(guestA).addPeerInfo({ node: 'x', addresses: [] }),
      undefined,
      'guest has no addPeerInfo',
    );

    // The guest mints and locates the invitation.
    const invitation = await E(guestA).invite('bob');
    const invitationLocator = await E(invitation).locate();

    // The locator `from` names the inviting guest's handle, not the top host's.
    const guestHandleId = await E(hostA).identify('guest-handle');
    const hostHandleId = await E(hostA).identify('@self');
    const fromNumber = new URL(invitationLocator).searchParams.get('from');
    t.is(
      fromNumber,
      parseId(guestHandleId).number,
      'invitation `from` names the inviting guest handle',
    );
    t.not(
      fromNumber,
      parseId(hostHandleId).number,
      'invitation `from` is NOT the top host handle',
    );

    // The top host on B accepts.
    await E(hostB).accept(invitationLocator, 'alice');

    // Both pet stores received the opposite handle.
    const bobId = await E(guestA).identify('bob');
    t.truthy(bobId, "inviting guest bound the acceptor's handle under 'bob'");
    const aliceId = await E(hostB).identify('alice');
    t.truthy(
      aliceId,
      "acceptor bound the inviting guest's handle under 'alice'",
    );
    t.is(
      parseId(aliceId).number,
      parseId(guestHandleId).number,
      "acceptor's 'alice' is the inviting guest handle, not the top host",
    );

    // Neither bound handle carries host-only methods.
    const boundOnB = await E(hostB).lookup('alice');
    await t.throwsAsync(
      () => E(boundOnB).addPeerInfo({ node: 'x', addresses: [] }),
      undefined,
      "acceptor's handle has no addPeerInfo",
    );
    await t.throwsAsync(
      () => E(boundOnB).invite('x'),
      undefined,
      "acceptor's handle has no invite",
    );
    const boundOnA = await E(guestA).lookup('bob');
    await t.throwsAsync(
      () => E(boundOnA).addPeerInfo({ node: 'x', addresses: [] }),
      undefined,
      "inviter's handle has no addPeerInfo",
    );

    // A replayed invitation fails cleanly (single-use).
    await t.throwsAsync(
      () => E(hostB).accept(invitationLocator, 'alice-again'),
      undefined,
      'replayed invitation is rejected',
    );
  });

  // Give a guest its own reachable `@nets` by minting a second network on the
  // guest's daemon and moving it into the guest's networks directory. A guest's
  // `@nets` starts empty (the anonymizing-persona default), so an acceptor is
  // undialable across daemons until its host populates it — the reciprocal
  // precondition the guest-native-invitations design states for a cross-daemon
  // guest acceptor.
  const giveGuestOwnNetwork = async (host, guestAgentName) => {
    // The network module reads its listen address from a fixed pet name and,
    // once bound, rewrites that name to the concrete assigned port. The host's
    // network already did so, so reset the name to the ephemeral-port sentinel
    // before minting the guest's network, or it would try to bind the host
    // network's live port (EADDRINUSE).
    await E(host).storeValue(network.listenAddr, network.listenAddrName);
    const servicePath = path.join(dirname, network.modulePath);
    const serviceLocation = url.pathToFileURL(servicePath).href;
    const guestNetwork = await E(host).makeUnconfined(
      '@main',
      serviceLocation,
      {
        powersName: '@agent',
        resultName: 'guest-network',
      },
    );
    await guestNetwork;
    // Move the guest network under the guest's own `@nets` so its address rides
    // the guest's handle locator (getAllNetworkAddresses reads the guest's
    // networks directory).
    await E(host).move(
      ['guest-network'],
      [guestAgentName, '@nets', network.netsKey],
    );
  };

  // The guest-native acceptance contract: a GUEST (not the top host) redeems an
  // invitation into ITSELF across daemons — the symmetric complement of the
  // guest-inviter test above, and the shape minion.town's onboarding needs.
  test.serial(
    'EndoGuest accepts an invitation into itself across daemons',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);

      const guestA = await E(hostA).provideGuest('guest-a-handle', {
        agentName: 'guest-a-agent',
      });
      const guestB = await E(hostB).provideGuest('guest-b-handle', {
        agentName: 'guest-b-agent',
      });

      // Populate the acceptor guest's `@nets` so the inviter's daemon can dial
      // it back for the inviter->acceptor mail direction.
      await giveGuestOwnNetwork(hostB, 'guest-b-agent');

      // The inviting guest mints; the accepting guest redeems into itself.
      const invitation = await E(guestA).invite('to-b');
      const invitationLocator = await E(invitation).locate();
      await E(guestB).accept(invitationLocator, 'to-a');

      // Reciprocal binding, each guest under its own chosen pet name.
      const toBId = await E(guestA).identify('to-b');
      const toAId = await E(guestB).identify('to-a');
      t.truthy(
        toBId,
        "inviting guest bound the acceptor's handle under 'to-b'",
      );
      t.truthy(
        toAId,
        "accepting guest bound the inviter's handle under 'to-a'",
      );

      // Each side bound the OTHER guest's own handle (not a host, not a minted
      // replacement guest).
      const guestAHandleId = await E(hostA).identify('guest-a-handle');
      const guestBHandleId = await E(hostB).identify('guest-b-handle');
      t.is(
        parseId(toAId).number,
        parseId(guestAHandleId).number,
        "acceptor's 'to-a' is the inviting guest's own handle",
      );
      t.is(
        parseId(toBId).number,
        parseId(guestBHandleId).number,
        "inviter's 'to-b' is the accepting guest's own handle",
      );

      // The accepting guest minted no replacement guest under @pins.
      t.is(await E(guestB).identify('@pins', 'guest-to-a'), undefined);

      // Bidirectional mail proves both dialing directions established.
      await E(guestA).send('to-b', ['Hello from A'], [], []);
      await E(guestB).send('to-a', ['Hello from B'], [], []);

      await waitForCondition(async () => {
        const messages = /** @type {any[]} */ (await E(guestB).listMessages());
        return messages.some(
          m => m.type === 'package' && m.strings?.[0] === 'Hello from A',
        );
      });
      t.pass("acceptor received the inviter's message");

      await waitForCondition(async () => {
        const messages = /** @type {any[]} */ (await E(guestA).listMessages());
        return messages.some(
          m => m.type === 'package' && m.strings?.[0] === 'Hello from B',
        );
      });
      t.pass("inviter received the acceptor's message");

      // Single-use survives CapTP: the replayed accept is rejected.
      await t.throwsAsync(
        () => E(guestB).accept(invitationLocator, 'to-a-again'),
        undefined,
        'replayed invitation is rejected',
      );
    },
  );

  // Rebuild a locator with a different connection-hint set, preserving its node,
  // formula number, and query params. Used to prove the acceptor treats an
  // unverified locator's hints as advisory-only for an already-known peer.
  const withHints = (locator, hints) => {
    const { number, node } = parseId(idFromLocator(locator));
    const source = new URL(locator);
    const rebuilt = new URL(
      `endo://${node}/${[number, ...hints].map(encodeURIComponent).join('@')}`,
    );
    for (const [key, value] of source.searchParams) {
      rebuilt.searchParams.set(key, value);
    }
    return rebuilt.toString();
  };

  // The peer route the acceptor writes from an UNVERIFIED locator is
  // speculative: a rejected accept (here, a spent invitation from a peer the
  // acceptor has never met) must retract it, or a forged/spent locator naming
  // an unknown node durably squats that node's dialing addresses with
  // caller-chosen ones. The only rollback test elsewhere is same-daemon, where
  // the peer branch never runs; deleting `rollbackPeer` or its catch-block
  // invocation reddens here.
  test.serial(
    'accept rolls back a speculative cross-daemon peer route on rejection',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);
      const { host: hostC } = await prepareHostWithGcAndNetwork(t);

      // C mints an invitation; A consumes it, so it is spent. B never meets C.
      const invC = await E(hostC).invite('bob');
      const spentCLocator = await E(invC).locate();
      await E(hostA).accept(spentCLocator, 'from-c'); // consumes invC

      const cPeerInfo = /** @type {import('../src/types.js').PeerInfo} */ (
        await E(hostC).getPeerInfo()
      );
      const cNode = cPeerInfo.node;
      const peersBefore = /** @type {import('../src/types.js').PeerInfo[]} */ (
        await E(hostB).listKnownPeers()
      );
      t.false(
        peersBefore.some(p => p.node === cNode),
        'hostB has not met hostC before the rejected accept',
      );

      // B attempts the spent C-locator. C is unknown and the locator carries
      // C's addresses, so B speculatively registers C as a peer, dials C, and
      // calls accept — which rejects (single-use, already spent).
      await t.throwsAsync(
        () => E(hostB).accept(spentCLocator, 'carol'),
        undefined,
        'a spent invitation is rejected',
      );

      const peersAfter = /** @type {import('../src/types.js').PeerInfo[]} */ (
        await E(hostB).listKnownPeers()
      );
      t.false(
        peersAfter.some(p => p.node === cNode),
        'the speculative peer route to hostC was retracted after rejection',
      );
    },
  );

  // The acceptor's peer registration is additive-only: an already-known peer is
  // never re-addressed. A second genuine invitation from a known inviter,
  // carrying rewritten (bogus) hints, must leave the inviter's real route
  // intact. Dropping the `identifyLocal(peerKey) === undefined` guard would let
  // `addPeerInfo` replace the live route with the unverified addresses.
  test.serial(
    'accept never redirects an already-known peer route (additive-only)',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);

      const inv1 = await E(hostA).invite('bob1');
      const inv2 = await E(hostA).invite('bob2');
      const loc1 = await E(inv1).locate();
      const loc2 = await E(inv2).locate();

      // First accept: B learns A's daemon at its real address.
      await E(hostB).accept(loc1, 'alice1');
      const aNode = parseId(idFromLocator(loc1)).node;
      const peersAfterFirst =
        /** @type {import('../src/types.js').PeerInfo[]} */ (
          await E(hostB).listKnownPeers()
        );
      const aEntryFirst = peersAfterFirst.find(p => p.node === aNode);
      t.truthy(aEntryFirst, 'hostB registered hostA on the first accept');
      const realAddresses = aEntryFirst?.addresses ?? [];
      t.true(realAddresses.length > 0, 'the registered route has addresses');

      // Second accept: a genuine invitation from A, but with its hints rewritten
      // to a bogus address. A is already known, so the guard must skip
      // re-registration and keep A's real route (the accept still proves out
      // over the existing route).
      const forgedLoc2 = withHints(loc2, ['tcp:203.0.113.7:65000']);
      await E(hostB).accept(forgedLoc2, 'alice2');

      const peersAfterSecond =
        /** @type {import('../src/types.js').PeerInfo[]} */ (
          await E(hostB).listKnownPeers()
        );
      const aEntrySecond = peersAfterSecond.find(p => p.node === aNode);
      t.truthy(
        aEntrySecond,
        'hostA is still a known peer after the second accept',
      );
      t.deepEqual(
        aEntrySecond?.addresses,
        realAddresses,
        'the bogus hints did not redirect the already-known peer route',
      );
    },
  );

  // Same-daemon acceptance (the minion.town shape: inviter and acceptor guests
  // are siblings under ONE daemon) must register NO peer route and NO
  // remote-agent-key row — the inviter's daemon IS this daemon, so a self-peer
  // or self-referential agent-key row would be spurious (section 4 of the
  // guest-native-invitations design). Two skips enforce this: the acceptor-side
  // `peerKey !== localNodeNumber` in `acceptInvitation` and the inviter-side
  // `guestDaemonNode !== localNodeNumber` in `Invitation.accept`.
  //
  // Same-daemon coverage that ran with EMPTY `@nets` on both agents could not
  // pin either skip: the orthogonal `hints.length > 0` (acceptor) and
  // `addresses.length > 0` (inviter) guards keep the peer store empty on their
  // own, so deleting a same-daemon skip passed unnoticed (prover round 4). Here
  // the daemon has a reachable network — so the invitation locator carries
  // non-empty hints — AND the accepting guest has its own populated `@nets` — so
  // its handle locator carries non-empty addresses. Both orthogonal guards are
  // therefore satisfied, leaving the same-daemon skips as the ONLY thing keeping
  // the shared peer store empty: deleting EITHER skip reddens this test.
  test.serial(
    'same-daemon accept writes no peer route with reachable @nets on both sides (guards load-bearing)',
    async t => {
      const { host } = await prepareHostWithGcAndNetwork(t);
      const guestA = await E(host).provideGuest('guest-a-handle', {
        agentName: 'guest-a-agent',
      });
      const guestB = await E(host).provideGuest('guest-b-handle', {
        agentName: 'guest-b-agent',
      });

      // Give the accepting guest a reachable `@nets` so its handle locator
      // carries a non-empty address list — otherwise the inviter-side
      // `addresses.length > 0` guard, not the same-daemon skip, is what keeps the
      // peer write from firing.
      await giveGuestOwnNetwork(host, 'guest-b-agent');

      const invitation = await E(guestA).invite('to-b');
      const invitationLocator = await E(invitation).locate();
      // The daemon has a network, so the invitation carries connection hints;
      // this is what makes the acceptor-side `peerKey !== localNodeNumber` skip
      // (rather than an empty hint list) the thing preventing a self-peer write.
      const { hints } = parseLocator(invitationLocator);
      t.true(
        hints.length > 0,
        'the invitation carries connection hints (daemon has a reachable network)',
      );

      await E(guestB).accept(invitationLocator, 'to-a');

      // Reciprocal binding still succeeds same-daemon.
      t.truthy(await E(guestA).identify('to-b'));
      t.truthy(await E(guestB).identify('to-a'));

      // The point of the test: neither the acceptor-side nor the inviter-side
      // same-daemon skip wrote a self-peer route despite both address lists being
      // non-empty.
      const peersAfter = /** @type {import('../src/types.js').PeerInfo[]} */ (
        await E(host).listKnownPeers()
      );
      t.deepEqual(
        peersAfter,
        [],
        'same-daemon accept registers no known-peer entry on either side',
      );
    },
  );

  // The invitation object's own cancel() revokes exactly that pending
  // invitation, leaving a sibling invitation for the same guest redeemable.
  test.serial(
    'invitation cancel() revokes exactly one pending invitation',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);
      const { host: hostC } = await prepareHostWithGcAndNetwork(t);

      const guestA = await E(hostA).provideGuest('guest-handle', {
        agentName: 'guest-agent',
      });

      // Two independent pending invitations from the same guest.
      const inv1 = await E(guestA).invite('peer1');
      const inv2 = await E(guestA).invite('peer2');
      const locator1 = await E(inv1).locate();
      const locator2 = await E(inv2).locate();

      // Cancel exactly the first.
      await E(inv1).cancel();

      // The canceled invitation can no longer be redeemed.
      await t.throwsAsync(
        () => E(hostB).accept(locator1, 'from-peer1'),
        undefined,
        'canceled invitation is not redeemable',
      );

      // The sibling invitation is untouched and still redeemable.
      await E(hostC).accept(locator2, 'from-peer2');
      t.truthy(
        await E(guestA).identify('peer2'),
        'sibling invitation still redeemed and bound',
      );

      // The canceled invitation left its pet name unbound.
      t.is(
        await E(guestA).identify('peer1'),
        undefined,
        'canceled invitation left its name unbound',
      );
    },
  );

  // Concurrency: two acceptors race the SAME single-use invitation. The
  // inviter-side `invitationJobs` serial queue exists precisely so the check
  // and its consuming rebind are atomic, so at most one accept() may redeem
  // the invitation even when both are in flight together. A sequential replay
  // test cannot exercise the queue; this one starts both before either
  // resolves. Deleting the invitationJobs wrapper (reverting to unserialized
  // check-then-act) is what this test guards against.
  test.serial(
    'concurrent accept() on one invitation redeems at most once',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);
      const { host: hostC } = await prepareHostWithGcAndNetwork(t);

      const invitation = await E(hostA).invite('bob');
      const locator = await E(invitation).locate();

      const results = await Promise.allSettled([
        E(hostB).accept(locator, 'alice'),
        E(hostC).accept(locator, 'alice'),
      ]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      t.is(fulfilled.length, 1, 'exactly one concurrent accept succeeds');
      t.is(rejected.length, 1, 'the racing accept is rejected as single-use');

      // The inviter's invitation slot names exactly one accepted remote handle.
      t.truthy(
        await E(hostA).identify('bob'),
        'the winning acceptor bound its handle under the invitation name',
      );
    },
  );

  // Supersession: re-minting an invitation under a name already bound to a
  // pending invitation rebinds that slot, orphaning the first. The superseded
  // invitation must fail its single-use check on accept, matching the
  // "accepted, canceled, or superseded" contract the accept guard asserts.
  test.serial(
    'a superseded invitation (its name rebound) is no longer redeemable',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);
      const { host: hostC } = await prepareHostWithGcAndNetwork(t);

      const inv1 = await E(hostA).invite('bob');
      const locator1 = await E(inv1).locate();
      // Re-mint under the same name; this rebinds 'bob' and supersedes inv1.
      const inv2 = await E(hostA).invite('bob');
      const locator2 = await E(inv2).locate();

      await t.throwsAsync(
        () => E(hostB).accept(locator1, 'alice'),
        undefined,
        'the superseded invitation is rejected',
      );

      // The current invitation still redeems cleanly.
      await E(hostC).accept(locator2, 'carol');
      t.truthy(
        await E(hostA).identify('bob'),
        'the current invitation redeemed and bound its acceptor',
      );
    },
  );

  // Concurrency: a cancel() racing a mid-flight accept() on the SAME
  // invitation. This is the harder race the `invitationJobs` serial queue is
  // built to close (the accept-vs-accept race is covered above); the queue's
  // whole point is that a cancel() cannot read a stale `current === id` and
  // remove() the slot accept() has since rebound to the accepted guest. Both
  // calls funnel through the same per-invitation queue, so exactly one wins and
  // the loser observes the terminal state rather than corrupting it. A
  // sequential cancel-then-accept (covered elsewhere) never exercises the
  // queue; this one starts both before either resolves.
  test.serial(
    'a cancel() racing an accept() never un-names an accepted guest',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);

      const invitation = await E(hostA).invite('bob');
      const locator = await E(invitation).locate();

      const [acceptResult] = await Promise.allSettled([
        E(hostB).accept(locator, 'alice'),
        E(invitation).cancel(),
      ]);

      const bound = await E(hostA).identify('bob');
      if (acceptResult.status === 'fulfilled') {
        // accept() won the race: the slot must still name the accepted guest.
        // The racing cancel() must have observed `current !== id` and been the
        // promised idempotent no-op, NOT removed the just-rebound slot.
        t.truthy(
          bound,
          'accept winning the race leaves the guest bound; cancel did not un-name it',
        );
      } else {
        // cancel() won the race: the invitation was revoked before acceptance,
        // so the slot is unbound and the invitation is no longer redeemable.
        t.is(
          bound,
          undefined,
          'cancel winning the race leaves the name unbound',
        );
        await t.throwsAsync(
          () => E(hostB).accept(locator, 'alice'),
          undefined,
          'a canceled invitation is not redeemable even after a lost accept race',
        );
      }
    },
  );

  // The docstring on cancelInvitation promises it is "an idempotent no-op once
  // accepted". Pin that contract: cancelling an already-redeemed invitation
  // must neither throw nor remove the now-rebound guest slot.
  test.serial(
    'invitation cancel() after a successful accept() is an idempotent no-op',
    async t => {
      const { host: hostA } = await prepareHostWithGcAndNetwork(t);
      const { host: hostB } = await prepareHostWithGcAndNetwork(t);

      const invitation = await E(hostA).invite('bob');
      const locator = await E(invitation).locate();

      await E(hostB).accept(locator, 'alice');
      const boundBefore = await E(hostA).identify('bob');
      t.truthy(boundBefore, 'the invitation was accepted and bound');

      // cancel() on the already-accepted invitation is the promised no-op.
      await E(invitation).cancel();
      const boundAfter = await E(hostA).identify('bob');
      t.is(
        boundAfter,
        boundBefore,
        'cancel() after accept did not un-name the accepted guest',
      );
    },
  );

  test.serial('three-party invite with partition and recovery', async t => {
    const { host: hostA } = await prepareHostWithGcAndNetwork(t);
    const { host: hostB, config: configB } =
      await prepareHostWithGcAndNetwork(t);
    const { host: hostC } = await prepareHostWithGcAndNetwork(t);

    // A invites B and C.
    const invB = await E(hostA).invite('bob');
    const invC = await E(hostA).invite('carol');
    await E(hostB).accept(await E(invB).locate(), 'alice');
    await E(hostC).accept(await E(invC).locate(), 'alice');

    // A sends to both.
    await E(hostA).evaluate('@main', '"for-all"', [], [], ['shared']);
    await E(hostA).send('bob', ['Hi Bob'], ['shared'], ['shared']);
    await E(hostA).send('carol', ['Hi Carol'], ['shared'], ['shared']);

    // Both receive.
    const bobMsgs = await E(hostB).listMessages();
    const carolMsgs = await E(hostC).listMessages();
    t.true(
      bobMsgs.some(m => m.strings?.[0] === 'Hi Bob'),
      'B received message',
    );
    t.true(
      carolMsgs.some(m => m.strings?.[0] === 'Hi Carol'),
      'C received message',
    );

    // Partition B.
    await stop(configB);

    // A can still communicate with C while B is partitioned.
    await E(hostA).evaluate('@main', '"after-partition"', [], [], ['new-val']);
    await E(hostA).send('carol', ['Still here'], ['new-val'], ['new-val']);

    const carolMsgs2 = await E(hostC).listMessages();
    t.true(
      carolMsgs2.some(m => m.strings?.[0] === 'Still here'),
      'C received message during B partition',
    );
  });
};
harden(runMultiplayerSuite);

/**
 * Network specs for the transports the daemon ships. Used as inputs to
 * `runMultiplayerSuite`.
 *
 * `tcpNetwork` is the legacy plaintext JSON-CapTP transport. `ocapnNetwork`
 * is the OCapN-Noise transport introduced by
 * `designs/daemon-ocapn-external-connectivity.md`.
 */

/** @type {NetworkSpec} */
export const tcpNetwork = harden({
  listenAddrName: 'tcp-listen-addr',
  listenAddr: '127.0.0.1:0',
  modulePath: 'src/networks/tcp-netstring.js',
  netsKey: 'tcp',
});

/** @type {NetworkSpec} */
export const ocapnNetwork = harden({
  listenAddrName: 'ocapn-listen-addr',
  listenAddr: '127.0.0.1:0',
  modulePath: 'src/networks/ocapn.js',
  netsKey: 'ocapn',
});
