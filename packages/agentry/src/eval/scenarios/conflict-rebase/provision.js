// @ts-check
/// <reference types="ses"/>

import fs from 'node:fs';
import path from 'node:path';

import { E } from '@endo/eventual-send';

import { initRepo, makePowersOver } from '../../repo.js';
import { makeConflictRebaseScenario } from './scenario.js';

export const appBaseText = `\
Release notes paragraph.
`;
harden(appBaseText);

export const appFeatureText = `\
Release notes paragraph with feature wording.
Feature sentence from branch.
`;
harden(appFeatureText);

export const appIntegrationText = `\
Release notes paragraph with integration wording.
`;
harden(appIntegrationText);

export const appResolvedText = `\
Release notes paragraph with integration wording.
Feature sentence from branch.
`;
harden(appResolvedText);

export const featureNoteText = `\
Feature note survives the rebase.
`;
harden(featureNoteText);

export const integrationNoteText = `\
Integration note stays present after the replay.
`;
harden(integrationNoteText);

/**
 * Provision a fresh conflict-rebase repository and return its elevated Git
 * capability. The elevated option is derived from the scenario requirements
 * by the registry; this provisioner does not infer authority from its name.
 *
 * @param {{ allowHistoryRewrite?: boolean }} [requirements]
 * @returns {Promise<import('../../types.js').ProvisionedGitScenario>}
 */
export const provisionConflictRebaseRepo = async (requirements = {}) => {
  const featureBranch = 'feature/conflict-rebase';
  const integrationBranch = 'integration';
  const { repoRoot, run, cleanup } = await initRepo({
    branch: 'main',
    prefix: 'agentry-eval-conflict-rebase-',
  });
  const revParse = async ref => (await run(['rev-parse', ref])).stdout.trim();
  const writeFile = (filePath, content) =>
    fs.promises.writeFile(path.join(repoRoot, filePath), content);
  const writeAndCommit = async (filePath, content, message) => {
    await writeFile(filePath, content);
    await run(['add', filePath]);
    await run(['commit', '-q', '-m', message]);
  };

  try {
    await writeAndCommit('app.txt', appBaseText, 'chore: initialize app text');
    const baseOid = await revParse('main');

    await run(['switch', '-q', '-c', featureBranch]);
    await writeAndCommit('app.txt', appFeatureText, 'feat: update app wording');
    await fs.promises.mkdir(path.join(repoRoot, 'notes'), { recursive: true });
    await writeAndCommit(
      'notes/feature.md',
      featureNoteText,
      'docs: add feature note',
    );
    const featureAppOid = await revParse(`${featureBranch}~1`);
    const featureNoteOid = await revParse(featureBranch);
    const originalFeatureOids = [featureAppOid, featureNoteOid];
    const setupPowers = makePowersOver(repoRoot, {
      allowHistoryRewrite: true,
    });
    const diffCommit = oid =>
      E(/** @type {any} */ (setupPowers.git)).diff({
        base: `${oid}^`,
        head: oid,
      });
    await run(['switch', '-q', '-c', integrationBranch, baseOid]);
    await writeFile('app.txt', appIntegrationText);
    await fs.promises.mkdir(path.join(repoRoot, 'notes'), { recursive: true });
    await writeFile('notes/integration.md', integrationNoteText);
    await run(['add', 'app.txt', 'notes/integration.md']);
    await run(['commit', '-q', '-m', 'feat: integrate app wording']);
    const integrationOid = await revParse(integrationBranch);

    await run(['switch', '-q', featureBranch]);
    try {
      await run(['rebase', integrationBranch]);
    } catch (error) {
      const message = /** @type {Error} */ (error).message;
      if (!/conflict|could not apply|CONFLICT/i.test(message)) {
        throw error;
      }
    }
    await writeFile('app.txt', appResolvedText);
    await run(['add', 'app.txt']);
    await run(['-c', 'core.editor=true', 'rebase', '--continue']);

    const replayed = (
      await run([
        'rev-list',
        '--reverse',
        `${integrationBranch}..${featureBranch}`,
      ])
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    const expectedPatches = await Promise.all(replayed.map(diffCommit));
    const featureTreeOid = await revParse(`${featureBranch}^{tree}`);
    await run(['reset', '--hard', featureNoteOid]);
    await run(['switch', '-q', featureBranch]);

    const powers = makePowersOver(repoRoot, {
      allowHistoryRewrite: requirements.allowHistoryRewrite === true,
    });
    const expected = harden({
      featureBranch,
      integrationBranch,
      integrationOid,
      replayedSummaries: ['feat: update app wording', 'docs: add feature note'],
      originalFeatureOids,
      expectedPatches,
      featureTreeOid,
      appText: appResolvedText,
      notes: [
        { path: 'notes/feature.md', content: featureNoteText },
        { path: 'notes/integration.md', content: integrationNoteText },
      ],
    });
    const scenario = makeConflictRebaseScenario(expected);
    return harden({
      ...powers,
      repoRoot,
      cleanup,
      scenario,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
};
harden(provisionConflictRebaseRepo);
