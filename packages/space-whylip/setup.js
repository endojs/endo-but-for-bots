// @ts-check
/* eslint-disable no-await-in-loop */
// Whylip owns ordinary Fae agents and borrows the shared Codex subscription.
// It installs no credential, inference broker, or alternate provider runtime.
import { E } from '@endo/eventual-send';
import { stableModuleSpecifier } from '@endo/fae/src/module-specifier.js';
import { inspectOwnedFactory } from '@endo/fae/src/owned-factory.js';
import { inspectInstalledOpenAI } from '@endo/fae/src/installed-openai.js';

const OWNER = harden(['@pins', 'installations', 'whylip']);
const booksSpecifier = stableModuleSpecifier('books.js', import.meta.url);
const oldBooksSpecifier = stableModuleSpecifier(
  'whylip-books.js',
  import.meta.resolve('@endo/fae'),
);
const installationPath = leaf => [...OWNER, leaf];

// Old setup scripts used absolute file paths; module formulas may also retain a
// pinned release URL. Compare these with the same durable current entrypoint.
const canonicalSpecifier = value => {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('/') && !value.startsWith('file:///')) return value;
  return stableModuleSpecifier(value, 'file:///');
};

/**
 * @param {any} host
 * @param {string[]} path
 */
const identify = async (host, path) => {
  await null;
  for (let i = 1; i <= path.length; i += 1) {
    if (!(await E(host).has(...path.slice(0, i)))) return undefined;
  }
  return E(host).identify(...path);
};

const setup = async (
  root,
  { model = 'gpt-5.6-sol', reasoningEffort = 'low' } = {},
) => {
  const diagnostics = await E(root).diagnostics();
  const connection = await inspectInstalledOpenAI(root);
  const fae = await inspectOwnedFactory(root, OWNER, connection);
  const expected = [
    ['books-state', 'guest'],
    ['books-handle', 'handle'],
    ['books-service', 'make-unconfined'],
  ];
  const ids = new Map();
  const formulas = new Map();
  for (const [leaf, type] of expected) {
    const id = await identify(root, installationPath(leaf));
    if (id) {
      const formula = await E(diagnostics).getFormula(id);
      if (formula.type !== type)
        throw Error('Conflicting Whylip installation binding');
      ids.set(leaf, id);
      formulas.set(leaf, formula);
    }
  }
  const booksPowersId = ids.get('books-state');
  const booksId = ids.get('books-service');
  if (Boolean(booksPowersId) !== Boolean(ids.get('books-handle')))
    throw Error('Incomplete Whylip installation pair');
  if (
    booksPowersId &&
    (formulas.get('books-state').properties.handle?.identifier !==
      ids.get('books-handle') ||
      formulas.get('books-handle').properties.agent?.identifier !==
        booksPowersId)
  )
    throw Error('Conflicting Whylip installation pair');
  const rootId = await E(root).identify('@agent');
  if ((booksPowersId || booksId) && !fae.factoryId)
    throw Error('Whylip books service has no retained factory');
  let booksPowers;
  if (booksPowersId) {
    if (formulas.get('books-state').properties.hostAgent?.identifier !== rootId)
      throw Error('Whylip books powers belong to another host');
    booksPowers = await E(root).lookup(installationPath('books-state'));
    for (const [name, target] of [
      ['root-host', rootId],
      ['factory', fae.factoryId],
    ]) {
      const id = await E(booksPowers).identify(name);
      if ((id !== undefined && id !== target) || (booksId && id === undefined))
        throw Error('Whylip books endowment changed');
    }
  }
  if (booksId) {
    const { properties } = formulas.get('books-service');
    if (
      !booksPowersId ||
      !fae.workerId ||
      properties.powers?.identifier !== booksPowersId ||
      properties.worker?.identifier !== fae.workerId ||
      ![booksSpecifier, oldBooksSpecifier].includes(
        canonicalSpecifier(properties.specifier?.value),
      ) ||
      Object.keys(await E(root).getFormulaEnvironment(booksId)).length !== 0
    )
      throw Error('Whylip books service dependencies changed');
  }
  const restored = await fae.provide({ model, reasoningEffort });
  if (!booksPowersId)
    await E(root).provideGuest(installationPath('books-handle'), {
      agentName: installationPath('books-state'),
    });
  booksPowers ??= await E(root).lookup(installationPath('books-state'));
  for (const [name, targetPath] of [
    ['root-host', ['@agent']],
    ['factory', fae.factoryPath],
  ]) {
    if (!(await E(booksPowers).has(name)))
      await E(booksPowers).storeLocator(
        name,
        await E(root).locate(...targetPath),
      );
  }
  if (!booksId)
    await E(root).makeUnconfined(fae.workerPath, booksSpecifier, {
      powersName: installationPath('books-state'),
      resultName: installationPath('books-service'),
    });
  return harden({ ready: true, restored });
};

// Serialize setup calls within an incarnation. Deployment also holds its normal
// operational lock; this prevents callers of this module racing one another.
const setups = new WeakMap();
/**
 * Install after the Fae OpenAI connection is ready. Existing recipes keep
 * their identity and model; changing defaults only affects a fresh installation.
 * @param {any} root
 * @param {{ model?: string, reasoningEffort?: string }} [options]
 */
export const setupWhylip = (root, options) => {
  const job = (setups.get(root) || Promise.resolve())
    .catch(() => {})
    .then(() => setup(root, options));
  setups.set(root, job);
  return job;
};
harden(setupWhylip);

/** @param {any} root */
export const main = root => setupWhylip(root);
harden(main);
