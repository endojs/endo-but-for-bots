// @ts-check

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * The scratch provider an adapter that grants no host scratch still has to
 * hold.
 *
 * `factory.make` — the attested path — requires a scratch provider before it
 * will build anything, because a slice policy may name host paths and
 * something has to be answerable for them. An adapter that resolves no host
 * paths at all therefore cannot pass `null`: a null provider closes `make`
 * outright, which reads as "this runtime is broken" rather than "this runtime
 * grants nothing".
 *
 * So the slot is filled with a capability that refuses. The distinction
 * matters: `makeResolved` never asked for one, so an adapter moving onto the
 * attested path acquires this requirement the moment it switches, and finds
 * out at its first session rather than at construction.
 */
export const makeNoHostScratch = () =>
  makeExo(
    'No host scratch',
    M.interface('NoHostScratch', {
      provideScratchMount: M.call().rest(M.arrayOf(M.any())).returns(M.any()),
      provideHostPath: M.call().rest(M.arrayOf(M.any())).returns(M.any()),
    }),
    {
      provideScratchMount() {
        throw Fail`Host scratch is forbidden`;
      },
      provideHostPath() {
        throw Fail`Host paths are forbidden`;
      },
    },
  );
harden(makeNoHostScratch);
