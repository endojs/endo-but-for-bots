// @ts-check
/**
 * Worked example — a multi-party thread: two mutually-suspicious parties'
 * content composed inline, each attributed by the frame, with a pattern badge
 * authenticating the composition.
 *
 *   import { renderConfined } from '@endo/preact-container/renderer';
 *   const { tree } = makeThreadExample({ secret });
 *   renderConfined(tree, container);
 *
 * Neither party can read the other's input or output (sibling opacity, from
 * confineComponent); the frame — trusted host code — draws both attributions
 * from the party objects and the reader's names.
 */
import { confineComponent } from '@endo/preact-container/compartment';

import { composeRegions } from '../src/composition.js';
import { makePatternBadge } from '../src/pattern-badge.js';
import { freeze } from '../src/freeze.js';

export const makeThreadExample = ({ secret }) => {
  // Parties are OBJECTS; the reader's names live host-side in a WeakMap.
  const alice = freeze({});
  const bram = freeze({});
  const book = new WeakMap([
    [alice, 'Alexa'],
    [bram, 'Bram'],
  ]);

  // Each party's content is a confined component: it renders its own words and
  // cannot reach the other party's props/output or the frame's names.
  const Post = confineComponent(({ h }, props) =>
    h('p', { class: 'post' }, String(props.text || '')),
  );

  const FrameBadge = makePatternBadge(secret, { label: 'Thread' });

  const tree = composeRegions(
    [
      {
        party: alice,
        Component: Post,
        props: { text: 'Shall we ship Friday?' },
      },
      {
        party: bram,
        Component: Post,
        props: { text: 'Agreed — after CI is green.' },
      },
    ],
    { nameOf: party => book.get(party), FrameBadge, label: 'Thread' },
  );

  return { tree, parties: { alice, bram } };
};
freeze(makeThreadExample);
