// @ts-check
import { Far } from '@endo/far';

/** Replace only the remote forge and real deployment effects in a daemon test. */
export const make = () => {
  let stages = 0;
  return Far('Test pull request', {
    verify: (repo, number, head) => harden({repo,number,head,base:'b'.repeat(40),url:'https://example.test/test/pulls/42'}),
    stageRev: async () => {
      stages += 1;
      throw Error('Test stops at staging');
    },
    stageCount: () => stages,
  });
};
harden(make);
