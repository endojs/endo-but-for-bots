// @ts-check
/**
 * The `Delegation` guard of the factory installed on states provisioned at
 * 51760a3996 (and every state before D-M9-25): `SpawnRequest` copied from
 * that revision's `guest/lib/guards/factory.js` ("SpawnRequest: () =>"),
 * built from today's `record`, `text`, `count` and `Attachments`, which
 * that revision's `guards/base.js` defined the same way. A closed record:
 * `modelId` and `reasoningEffort` are refused by the guard itself.
 */
/* eslint-disable import/no-relative-packages */
import {
  count,
  record,
  shapes as S,
  text,
} from '../../guest/lib/guards/base.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { M } = /** @type {GuestGlobals} */ (globalThis);

export const olderSpawnRequest = record(
  {
    name: text(limits.subagentNameUnits),
    attachments: S.Attachments,
    at: count,
  },
  // Inline only (D-M9-20): the factory composes the child's prompt
  // as text in the creation's resolver.
  { systemPrompt: text(limits.inlineBytes) },
);

export const olderDelegationGuard = M.interface('Delegation', {
  spawn: M.callWhen(olderSpawnRequest).returns(M.any()),
  children: M.call().returns(M.any()),
});
