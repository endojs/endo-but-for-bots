// @ts-check
import harden from '@endo/harden';
import { E } from '@endo/eventual-send';

export const WHYLIP_BOOKS_PATH = harden([
  '@pins',
  'installations',
  'whylip',
  'books-service',
]);

/** @param {any} root */
const ownedService = async root => {
  const service = await E(root).lookup(WHYLIP_BOOKS_PATH);
  const [caller, owner] = await Promise.all([
    E(root).identify('@self'),
    E(service).getOwnerIdentity(),
  ]);
  if (
    typeof caller !== 'string' ||
    !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(caller) ||
    caller !== owner
  )
    throw Error('Whylip books must be managed from their installation host');
  return service;
};

/**
 * Book provisioning runs in the installed daemon service, so retry and
 * concurrency recovery survives browser disconnects.
 * @param {any} root
 * @param {{ name: string }} options
 */
export const createWhylipBook = async (root, { name }) => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name))
    throw Error('Invalid Whylip book name');
  await null;
  for (let i = 1; i <= WHYLIP_BOOKS_PATH.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(root).has(...WHYLIP_BOOKS_PATH.slice(0, i))))
      throw Error('Whylip books service is not installed');
  }
  const service = await ownedService(root);
  return E(service).createBook(name);
};
harden(createWhylipBook);

/**
 * @param {any} root
 * @param {any} config
 */
export const provideWhylipSpace = async (root, config) => {
  const service = await ownedService(root);
  return E(service).provideSpace(harden(config));
};
harden(provideWhylipSpace);
