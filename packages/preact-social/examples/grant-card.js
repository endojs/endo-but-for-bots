// @ts-check
/**
 * Worked example — a security-critical confirmation woven inline in untrusted
 * content, badged with the user's pattern so it cannot be spoofed, and owning
 * its own confirm handler so the guest cannot decide what the button does.
 *
 *   import { renderConfined } from '@endo/preact-container/renderer';
 *   import { h } from 'preact';
 *   const { GrantCard } = makeGrantCardExample({ secret, onConfirm });
 *   // the confined chat places it: h(ChatWithGrant, { GrantCard })
 *
 * The card demonstrates three disciplines at once (see PATTERNS.md):
 *  - the pattern badge makes the real card recognizable (unspoofable);
 *  - the card OWNS its `onConfirm` — never accepts a handler as a prop;
 *  - `amount` is an attacker-provided designator: rendered as text, and the
 *    host's `onConfirm` re-validates it.
 */
import { confineComponent } from '@endo/preact-container/compartment';

import { makePatternBadge } from '../src/pattern-badge.js';
import { withPrimitiveParams } from '../src/modifiers.js';
import { freeze } from '../src/freeze.js';

export const makeGrantCardExample = ({ secret, onConfirm }) => {
  const Badge = makePatternBadge(secret, { label: 'Grant request' });

  const GrantCard = confineComponent(
    // `amount` must be a primitive designator; the card owns its handler.
    withPrimitiveParams(({ h }, { amount }) =>
      h(
        'div',
        { class: 'grant-card' },
        h(Badge, {}),
        h('span', null, ` Approve sending ${amount}? `),
        h(
          'button',
          {
            class: 'grant-confirm',
            // Owned here. A handler arriving as a prop would let the guest
            // decide what your click does inside chrome that looks trusted.
            onClick: () => onConfirm(amount),
          },
          'Confirm',
        ),
      ),
    ),
    { name: 'GrantCard' },
  );

  return { GrantCard, Badge };
};
freeze(makeGrantCardExample);
