// @ts-check

/**
 * Method-guard shapes for the Content-Address Store interface.
 *
 * The name is `CasInterface` rather than `CasStoreInterface`: CAS
 * already expands to Content-Address Store, so `CasStore` would have
 * read "Content-Address-Store Store". The interface guards an exo
 * that other backends (a future `@endo/git-cas`, the daemon's
 * persistent `store-sha256` tree) implement.
 */

import { M } from '@endo/patterns';

const HashShape = M.string();

/**
 * The CAS interface a content-addressed registry (or any other CAS
 * consumer) sits in front of.
 */
export const CasInterface = M.interface('Cas', {
  has: M.call(HashShape).returns(M.promise()),
  read: M.call(HashShape).returns(M.promise()),
  write: M.call(M.any()).returns(M.promise()),
  evict: M.call(HashShape).returns(M.promise()),
  list: M.call().returns(M.promise()),
});
