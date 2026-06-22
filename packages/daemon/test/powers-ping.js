// A test fixture for `makeUnconfined`'s by-reference `powers` option.
//
// Its `make(powers)` calls a method on whatever powers cap it was
// instantiated with and re-exports the result, so a test can prove the
// caplet was wired to a specific powers capability (rather than a fresh
// guest or a named pet-store entry).

import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

export const make = async powers => {
  const pong = await E(powers).ping();
  return makeExo(
    'PowersPing',
    M.interface('PowersPing', {}, { defaultGuards: 'passable' }),
    {
      pong() {
        return pong;
      },
    },
  );
};
