// Runs INSIDE the minion.town Pet Daemon container, against its live control
// socket (/data/endo.sock). Mints an invitation for a remote local peer and
// publishes a Far capability, printing both locators as machine-readable lines
// so the local driver can accept the invitation and invoke the capability
// across the wss:// + Noise edge.
//
// Usage (inside the container):
//   node demo/cross-host-invite-accept/minion-mint-invitation.mjs [guestName]
//
// Emits on stdout:
//   INVITATION <locator>
//   ADDER <locator>
//   NODE <nodeId>
import '@endo/init';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient } from '../../index.js';

const sockPath = process.env.ENDO_SOCK_PATH || '/data/endo.sock';
const guestName = process.argv[2] || `localpeer-${process.pid}`;
const adderName = `xhost-adder-${process.pid}`;

const { promise: cancelled, reject: cancel } = makePromiseKit();
cancelled.catch(() => {});

const { getBootstrap, closed } = await makeEndoClient(
  'xhost-minter',
  sockPath,
  cancelled,
);
closed.catch(() => {});
const host = E(getBootstrap()).host();

const nodeId = await E(host)
  .identify('@self')
  .catch(() => undefined);

// Publish a Far capability the local peer will invoke back across the edge.
await E(host).evaluate(
  '@main',
  'Far("Adder", { add: (a, b) => a + b, greet: who => `hello ${who} from minion.town` })',
  [],
  [],
  [adderName],
);
const adderLocator = await E(host).locate(adderName);

// Mint the durable invitation; its locator advertises this daemon's
// @nets/ocapn connection hints (loopback ws:url — rewritten public-side).
const invitation = await E(host).invite(guestName);
const invitationLocator = await E(invitation).locate();

console.log(`NODE ${nodeId}`);
console.log(`ADDER ${adderLocator}`);
console.log(`INVITATION ${invitationLocator}`);

cancel(new Error('done'));
process.exit(0);
