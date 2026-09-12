// Capture diagnostic powers before SES removes them from the guest globals.
const { WeakRef: HostWeakRef, gc } = globalThis;
if (!gc) throw Error('This fixture requires --expose-gc');
await import('@endo/init');
const { makeNodePowers } = await import('../src/platform/node-powers.js');
const nodePowers = makeNodePowers();
const { Far } = await import('@endo/far');
const { setImmediate } = await import('node:timers/promises');
const { makeInventoryViewLifetime } =
  await import('../src/inventory/inventory-view-lifetime.js');

/** @type {(value: any) => void} */
let resolveSubscription = () => {
  throw Error('Setup promise missing');
};
const stalledSetup = new Promise(resolve => {
  resolveSubscription = resolve;
});
let bridge;
const inventory = Far('Inventory', {
  subscribe: listener => {
    bridge = listener;
    return stalledSetup;
  },
});
const registrations = new Map();
const swallow = () => {};
function connect(socket) {
  const weak = new HostWeakRef(socket);
  const lifetime = makeInventoryViewLifetime(nodePowers.timers, inventory, 0);
  const observer = Far('Observer', { changed: () => socket.name });
  void lifetime.watch(observer).catch(swallow);
  const disconnect = () => {
    registrations.delete(socket);
    return lifetime.disconnect();
  };
  registrations.set(socket, disconnect);
  return { closed: disconnect(), weak };
}
const { closed, weak } = connect({ name: 'closed socket' });
await closed;
// The guest's unresolved setup promise and bridge intentionally remain rooted.
if (!bridge || !weak) throw Error('Expected retained bridge and socket probe');
for (let i = 0; i < 20; i += 1) {
  // WeakRef targets remain alive within a turn; each collection needs a new one.
  // eslint-disable-next-line no-await-in-loop
  await setImmediate();
  gc();
}
if (weak.deref() !== undefined)
  throw Error('Pending setup retained the closed socket scope');
let cancelled = false;
resolveSubscription(
  Far('Subscription', {
    unsubscribe: () => {
      cancelled = true;
    },
  }),
);
await setImmediate();
await setImmediate();
if (!cancelled) throw Error('Late setup did not receive cancellation');
console.log('released socket; cancelled late subscription');
