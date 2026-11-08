// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const ProjectRevisionInterface = M.interface('ProjectRevision', {
  revParse: M.callWhen(M.string(), M.string()).returns(M.record()),
  pinCandidate: M.callWhen(M.string(), M.string()).returns(M.record()),
});

/** @param {string} ref */
const isObjectId = ref => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(ref);

/**
 * Durable caplet adapter for the workflow's trailing invocation key. Resolving
 * a ref is read-only; the workflow journals the resolved OID before asking any
 * reviewer. This grants no Git mutation methods to a workflow starter.
 * @param {any} powers - read-only Git capability
 */
export const make = powers => {
  /** @param {string} ref */
  const resolveCommit = async ref => {
    const revision = await E(powers).revParse(ref);
    if (typeof revision.oid !== 'string' || !isObjectId(revision.oid)) {
      throw Error('Revision did not resolve to a Git object ID');
    }
    // Resolve a commit, not a tag/tree/blob masquerading as a candidate.
    const commit = await E(powers).revParse(`${revision.oid}^{commit}`);
    if (typeof commit.oid !== 'string' || !isObjectId(commit.oid))
      throw Error('Expected a commit object ID');
    return commit;
  };
  return makeExo('ProjectRevision', ProjectRevisionInterface, {
    // The invocation key is part of the workflow protocol. These reads need
    // no deduplication, but the public signature must still accept the key.
    /**
     * @param {string} ref
     * @param {string} key
     */
    revParse: (ref, key) => resolveCommit(ref),
    /**
     * @param {string} ref
     * @param {string} key
     */
    pinCandidate: async (ref, key) => {
      // The developer may already be processing another request when this
      // invocation runs. A symbolic ref could move after submission, so only
      // immutable object IDs may identify submitted work.
      if (!isObjectId(ref)) throw Error('Submit a full commit object ID');
      return resolveCommit(ref);
    },
  });
};
harden(make);
