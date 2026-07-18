// @ts-check
/// <reference types="ses"/>

// This module holds the reference `evaluate` source for the stack-surgery
// scenario, which a competent code-mode agent should converge on.
// Keep it beside the scenario so `makeStackSurgeryScenario`'s
// `referenceSourcePath` / `referenceSourceExport` fields can point here.
// The no-LLM test imports it to drive the scripted faux model, and a live run's
// `results.jsonl` row carries the same path/export pair so a downstream
// reporter can link a scenario's transcript to its reference solution.

/**
 * @typedef {object} StackSurgerySplitCommit
 * @property {string} path Repository-relative file the split commit owns.
 * @property {string} summary Conventional summary for that split commit.
 */

/**
 * Build the reference `evaluate` source for the stack-surgery scenario.
 *
 * The mixed alpha/beta commit is split with the sanctioned no-reset recipe
 * (designs/agentry-git-verb-gaps.md, "Reset Is Not Added"): create a branch at
 * the mixed commit's parent with `switchAfterCreate`, read each selected file
 * out of the mixed commit's tree through `filesystemAt(ref)`, write it into
 * the workspace, then `add` and `commit`. The original fixup commits are
 * cherry-picked with `noCommit` and re-committed as fixups of the split
 * commits so a `rebase({ autosquash: true })` squashes them away, the side
 * branches are replayed by `cherryPick` in the requested order, and the vague
 * beta test commit is replayed and reworded.
 *
 * The compartment a code-mode agent evaluates in has no `TextDecoder` and no
 * `atob`, so the source carries its own base64 text decode and drains the
 * `PassableBytesReader` handshake (one synchronize node per acknowledge node)
 * with plain promises.
 *
 * @param {object} options
 * @param {string} options.topicBranch The messy branch the run starts on.
 * @param {string} options.reworkBranch Branch name for the rebuilt stack.
 * @param {string} options.mixedSummary Summary of the mixed alpha/beta commit.
 * @param {StackSurgerySplitCommit[]} options.splitCommits Oldest-first split
 *   targets carved out of the mixed commit.
 * @param {string[]} options.sideBranches Side branches to replay, in order.
 * @param {string} options.betaTestSummary Reworded beta test commit summary.
 * @returns {string}
 */
export const stackSurgerySource = ({
  topicBranch,
  reworkBranch,
  mixedSummary,
  splitCommits,
  sideBranches,
  betaTestSummary,
}) => `\
(async () => {
  const topicBranch = ${JSON.stringify(topicBranch)};
  const reworkBranch = ${JSON.stringify(reworkBranch)};
  const mixedSummary = ${JSON.stringify(mixedSummary)};
  const splitCommits = ${JSON.stringify(splitCommits)};
  const sideBranches = ${JSON.stringify(sideBranches)};
  const betaTestSummary = ${JSON.stringify(betaTestSummary)};

  const current = await E(git).currentBranch();
  if (current?.name !== topicBranch) {
    throw new Error('not on the stack-surgery topic branch');
  }

  // Decode one base64-encoded chunk to text. The compartment has no
  // TextDecoder and no atob; the scenario's files are ASCII, so a
  // byte-per-character decode is faithful.
  const base64Alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decodeBase64Text = encoded => {
    let text = '';
    let buffer = 0;
    let bits = 0;
    for (const character of encoded) {
      if (character === '=') {
        break;
      }
      const value = base64Alphabet.indexOf(character);
      if (value < 0) {
        throw new Error('unexpected base64 character in stream chunk');
      }
      buffer = ((buffer << 6) | value) & 0x3fff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        text += String.fromCharCode((buffer >> bits) & 0xff);
      }
    }
    return text;
  };

  // Drain a PassableBytesReader into text: resolve one synchronize node per
  // chunk, then await the acknowledge node carrying the base64-encoded chunk,
  // until the terminal node (promise === null).
  const drainReaderText = async reader => {
    let resolveSynchronize;
    const synchronizeHead = new Promise(resolve => {
      resolveSynchronize = resolve;
    });
    let acknowledgePromise = E(reader).streamBase64(synchronizeHead);
    let text = '';
    for (;;) {
      let resolveNext;
      const nextSynchronize = new Promise(resolve => {
        resolveNext = resolve;
      });
      resolveSynchronize(
        harden({ value: undefined, promise: nextSynchronize }),
      );
      resolveSynchronize = resolveNext;
      const node = await acknowledgePromise;
      if (node.promise === null) {
        return text;
      }
      text += decodeBase64Text(await node.value);
      acknowledgePromise = node.promise;
    }
  };

  // Read one tracked file's text out of the committed tree at ref.
  const readCommittedText = async (ref, filePath) => {
    const committedFilesystem = await E(git).filesystemAt(ref);
    const committedRoot = await E(committedFilesystem).root();
    const file = await E(committedRoot).lookup(filePath.split('/'));
    return drainReaderText(await E(file).read());
  };

  // Overwrite a workspace file at a repository-relative path.
  const writeWorkspaceText = async (filePath, content) => {
    const segments = filePath.split('/');
    const name = segments.pop();
    let directory = await E(workspace).root();
    for (const segment of segments) {
      directory = await E(directory).lookup(segment);
    }
    await E(directory).write(name, content);
  };

  // Stage every pending change.
  const stageAll = async () => {
    const rows = await E(git).status();
    if (rows.length === 0) {
      throw new Error('expected pending changes to stage');
    }
    await E(git).add(rows.map(row => row.entry));
  };

  // Locate the mixed commit and the commits stacked on top of it.
  const history = await E(git).log({});
  const mixedIndex = history.findIndex(
    entry => entry.summary === mixedSummary,
  );
  if (mixedIndex < 0) {
    throw new Error('mixed commit not found on the topic branch');
  }
  const mixed = history[mixedIndex];
  const stackedNewestFirst = history.slice(0, mixedIndex);
  const fixups = stackedNewestFirst
    .filter(entry => entry.summary.startsWith('fixup! '))
    .reverse();
  const replayedCommits = stackedNewestFirst
    .filter(entry => !entry.summary.startsWith('fixup! '))
    .reverse();

  // Split the mixed commit without reset: branch at its parent, then commit
  // each selected file out of the mixed commit's tree on its own.
  await E(git).createBranch(reworkBranch, {
    startPoint: mixed.oid + '^',
    switchAfterCreate: true,
  });
  for (const splitCommit of splitCommits) {
    const content = await readCommittedText(mixed.oid, splitCommit.path);
    await writeWorkspaceText(splitCommit.path, content);
    await stageAll();
    await E(git).commit(splitCommit.summary);
  }

  // Re-target each original fixup commit at the split commit whose package it
  // touches, then autosquash them away.
  for (const fixup of fixups) {
    await E(git).cherryPick(fixup.oid, { noCommit: true });
    const staged = await E(git).status();
    const packages = staged.map(row => row.path.split('/')[0]);
    const target = splitCommits.find(splitCommit =>
      packages.includes(splitCommit.path.split('/')[0]),
    );
    if (target === undefined) {
      throw new Error('fixup commit does not touch a split commit package');
    }
    await E(git).commit('fixup! ' + target.summary);
  }
  await E(git).rebase({
    mode: 'start',
    upstream: mixed.oid + '^',
    autosquash: true,
  });

  // Replay the side branches in the requested order, then the remaining
  // stacked commit (the vague beta test commit), reworded to its target.
  for (const sideBranch of sideBranches) {
    await E(git).cherryPick(sideBranch);
  }
  for (const replayedCommit of replayedCommits) {
    await E(git).cherryPick(replayedCommit.oid);
  }
  await E(git).reword('HEAD', betaTestSummary);
})()`;
harden(stackSurgerySource);
