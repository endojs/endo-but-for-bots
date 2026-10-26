// @ts-check

// A test runner caplet whose powers are a child's driver guest. While its
// lifecycle facet reports active, it answers each message in the child's
// mailbox with an echo. Each incarnation records a fresh nonce in the driver
// guest's directory on activation, so a test can tell a revived runner from
// the one before the restart without calling it.

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

/** @param {any} powers */
export const make = async powers => {
  const lifecycle = await E(powers).lookup('agent-lifecycle');
  const agent = await E(powers).lookup('agent');
  const incarnation = `${Date.now()}-${Math.random()}`;
  let announced = false;
  let stopped = false;

  const tick = async () => {
    await null;
    if (!(await E(lifecycle).isActive())) return;
    if (!announced) {
      await E(powers).storeValue(harden({ incarnation }), 'alive');
      announced = true;
    }
    const messages = await E(agent).listMessages();
    for (const message of messages) {
      if (message.type === 'package') {
        // eslint-disable-next-line no-await-in-loop
        await E(agent).reply(
          message.number,
          [`echo: ${message.strings.join('')}`],
          [],
          [],
        );
        // eslint-disable-next-line no-await-in-loop
        await E(agent).dismiss(message.number);
      }
    }
  };
  const loop = () => {
    if (stopped) return;
    tick().then(
      () => setTimeout(loop, 50),
      () => {
        // A cancelled driver guest rejects; this incarnation is over.
        stopped = true;
      },
    );
  };
  loop();

  return Far('EchoRunner', {
    incarnation: () => incarnation,
  });
};
