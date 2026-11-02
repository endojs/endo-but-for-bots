// @ts-check

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { Fail, q } from '@endo/errors';

import { fetchPackage } from '../packages/fetch.js';
import { parsePackageSource } from '../packages/manifest.js';
import { makePackageStore } from '../packages/store.js';

/** @import { PackageRecord, PackageSource } from '../packages/types.js' */

/** @param {boolean | undefined} project */
const openStore = project =>
  makePackageStore(project ? process.cwd() : os.homedir());

/**
 * Reports a refused operation as a message rather than a stack trace.
 *
 * @param {() => Promise<void>} body
 */
const reportingFailure = async body => {
  await null;
  try {
    await body();
  } catch (error) {
    console.error(`endo: ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
  }
};

/** @param {PackageRecord} record */
const describeRecord = ({ id, version, enabled, pinned, resources }) => {
  const contents = Object.entries(resources)
    .map(([kind, names]) => `${names.length} ${kind}`)
    .join(', ');
  const flags = [
    enabled ? 'enabled' : 'disabled',
    ...(pinned ? ['pinned'] : []),
  ];
  return `${id} ${version === undefined ? '-' : version}: ${contents} (${flags.join(', ')})`;
};

/**
 * @param {ReturnType<typeof makePackageStore>} store
 * @param {PackageSource} source
 */
const fetchAndInstall = async (store, source) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'endo-package-'),
  );
  try {
    const packageRoot = await fetchPackage(source, temporaryDirectory);
    const { record, warnings } = await store.install(source, packageRoot);
    for (const warning of warnings) {
      console.error(`endo: ${warning}`);
    }
    for (const [kind, directories] of Object.entries(record.pending)) {
      if (directories.length > 0) {
        console.error(
          `endo: ${source.id} also declares ${kind} (${directories.join(', ')}); these were not installed because the CLI has no destination for ${kind} yet`,
        );
      }
    }
    console.log(`installed ${describeRecord(record)}`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
};

/**
 * @param {object} options
 * @param {string} options.sourceText
 * @param {boolean} [options.project]
 */
export const installPackage = async ({ sourceText, project }) =>
  reportingFailure(async () => {
    const source = parsePackageSource(sourceText, process.cwd());
    await fetchAndInstall(openStore(project), source);
  });

/**
 * @param {object} options
 * @param {boolean} [options.project]
 * @param {boolean} [options.json]
 */
export const listPackages = async ({ project, json }) =>
  reportingFailure(async () => {
    const records = await openStore(project).list();
    if (json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    for (const record of records) {
      console.log(describeRecord(record));
    }
  });

/**
 * @param {object} options
 * @param {string[]} options.sourceTexts
 * @param {boolean} [options.project]
 */
export const removePackages = async ({ sourceTexts, project }) =>
  reportingFailure(async () => {
    const store = openStore(project);
    for (const sourceText of sourceTexts) {
      const { id } = parsePackageSource(sourceText, process.cwd());
      // eslint-disable-next-line no-await-in-loop
      await store.remove(id);
      console.log(`removed ${id}`);
    }
  });

/**
 * @param {object} options
 * @param {string} options.sourceText
 * @param {boolean} options.enabled
 * @param {boolean} [options.project]
 */
export const configurePackage = async ({ sourceText, enabled, project }) =>
  reportingFailure(async () => {
    const { id } = parsePackageSource(sourceText, process.cwd());
    await openStore(project).setEnabled(id, enabled);
    console.log(`${enabled ? 'enabled' : 'disabled'} ${id}`);
  });

/**
 * Fetches every named install again, or every install when none is named.
 * Pinned installs stay at their pin; installing a new pin is how they move.
 *
 * @param {object} options
 * @param {string[]} options.sourceTexts
 * @param {boolean} [options.project]
 */
export const updatePackages = async ({ sourceTexts, project }) =>
  reportingFailure(async () => {
    const store = openStore(project);
    const records = await store.list();
    const ids = sourceTexts.map(
      sourceText => parsePackageSource(sourceText, process.cwd()).id,
    );
    for (const id of ids) {
      records.some(record => record.id === id) ||
        Fail`No package ${q(id)} is installed`;
    }
    for (const record of records) {
      if (ids.length === 0 || ids.includes(record.id)) {
        if (record.pinned) {
          console.log(`skipped ${record.source}: pinned`);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await fetchAndInstall(
            store,
            parsePackageSource(record.source, process.cwd()),
          );
        }
      }
    }
  });
