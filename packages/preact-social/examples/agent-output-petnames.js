// @ts-check
/**
 * Worked example — petnames woven into model-authored (untrusted) content.
 *
 * An "agent" component is confined: it was handed references to some parties
 * and weaves them into prose, but it cannot read the reader's names for them,
 * nor forge the name chips. The reader sees their own petnames inline.
 *
 * Render the returned tree through `renderConfined`:
 *
 *   import { renderConfined } from '@endo/preact-container/renderer';
 *   import { h } from 'preact';
 *   const { AgentMessage, props } = makeAgentOutputExample();
 *   renderConfined(h(AgentMessage, props), container);
 */
import { confineComponent } from '@endo/preact-container/compartment';

import { makePetName } from '../src/petname.js';
import { freeze } from '../src/freeze.js';

export const makeAgentOutputExample = () => {
  // Parties are OBJECTS. The address book maps object → local name and is NEVER
  // handed to the guest; only its ANSWERS reach the DOM, via the sealed chip.
  const alice = freeze({});
  const bram = freeze({});
  const stranger = freeze({}); // a real party we have not named yet
  const book = new WeakMap([
    [alice, 'Alexa'],
    [bram, 'Bram'],
  ]);

  const PetName = makePetName(party => book.get(party));

  // The untrusted agent. It receives party references as props and places name
  // chips; it never sees a name and cannot draw a chip that would be trusted.
  const AgentMessage = confineComponent(({ h }, rawProps) => {
    // A confined guest interprets its own (externally-supplied) props. The host
    // handed it the PetName chip and the party OBJECTS to weave in; the cast
    // just names that shape — it grants no new authority.
    const props =
      /** @type {{ PetName: import('preact').ComponentType<any>, alice: object, bram: object, stranger: object }} */ (
        rawProps
      );
    return h(
      'p',
      { class: 'agent-message' },
      'Reply to ',
      h(props.PetName, { party: props.alice }),
      ', loop in ',
      h(props.PetName, { party: props.bram }),
      ', and ignore ',
      h(props.PetName, { party: props.stranger }), // renders "unnamed"
      '.',
    );
  });

  return { AgentMessage, props: { PetName, alice, bram, stranger } };
};
freeze(makeAgentOutputExample);
