// @ts-check
/* global process */

/**
 * Host-setup helpers shared by the CLI adapters' `setup-host.js` and
 * `setup-hosted.js` scripts and by their backends: reading a provisioned
 * formula by its verified entrypoint, validating runtime placement against
 * guest storage roots, persisting the explicit runtime construction policy,
 * refusing runtime-directory leftovers a retired runtime left under a label,
 * and pinning a slice image reference. Each adapter binds its own label,
 * names, and specifiers.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';
import { assertPrivateDirectory } from '@endo/sandbox/private-directory.js';
import { readRuntimeConfig } from '@endo/sandbox/runtime-config.js';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Read one immutable formula by the ID captured from its current binding.
 * Do not revive it or resolve the mutable pet name again between reads. The
 * formula must be a `make-unconfined` with exactly the expected literal
 * specifier: a generic or unknown entrypoint under the name is refused rather
 * than adopted, since removing a name alone never proves its runtime stopped.
 *
 * @param {any} host The `@agent` host powers.
 * @param {object} options
 * @param {string} options.label The adapter's name for messages.
 * @param {string[]} options.namePath The pet name path of the formula;
 *   messages name its last segment.
 * @param {string} options.expectedSpecifier
 * @returns {Promise<{ identifier: string, env: Record<string, string> }>}
 */
export const readProvisionedEnvironment = async (
  host,
  { label, namePath, expectedSpecifier },
) => {
  const name = namePath[namePath.length - 1];
  const identified = await E(host).identify(...namePath);
  if (!identified) throw Fail`Cannot identify ${b(label)} ${q(name)}`;
  // The daemon returns a formula ID; identify's public type erases its brand.
  const identifier = /** @type {string} */ (identified);
  const record = await E(E(host).diagnostics()).getFormula(identifier);
  const specifier = record.properties.specifier;
  (record.type === 'make-unconfined' &&
    specifier?.kind === 'literal' &&
    specifier.value === expectedSpecifier) ||
    Fail`${b(label)} ${b(name)} has an unsupported entrypoint. Retire the old runtime and prove its processes have stopped before replacing its formula; removing its name alone is insufficient.`;
  const env = await E(host).getFormulaEnvironment(identifier);
  return harden({ identifier, env: env ?? {} });
};
harden(readProvisionedEnvironment);

/**
 * Canonicalize existing ancestors without creating a future guest storage root.
 * The operator must keep these ancestors outside guest rename authority.
 * @param {string} name
 * @param {string} [label]
 * @returns {Promise<string>}
 */
export const resolveFuturePath = async (name, label = 'Hosted') => {
  await null;
  try {
    return await fs.realpath(name);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw error;
    const existing = await fs.lstat(name).catch(missing => {
      if (/** @type {NodeJS.ErrnoException} */ (missing).code !== 'ENOENT')
        throw missing;
      return undefined;
    });
    !existing || Fail`${b(label)} storage path has an unresolved symlink`;
    const parent = path.dirname(name);
    if (parent === name) throw error;
    return path.join(
      await resolveFuturePath(parent, label),
      path.basename(name),
    );
  }
};
harden(resolveFuturePath);

/**
 * Validate operator placement, including guest roots which do not exist yet.
 * No mkdir/chmod adoption: the runtime parent is provisioned by the deployment.
 * The caller supplies effective persisted roots where a formula already exists.
 * @param {string} directory
 * @param {Record<string, string>} roots
 * @param {string} [label]
 * @returns {Promise<string>} The canonical runtime directory.
 */
export const assertRuntimePlacement = async (
  directory,
  roots,
  label = 'Hosted',
) => {
  const canonical = await assertPrivateDirectory(directory, fs);
  for (const root of Object.values(roots)) {
    path.isAbsolute(root) || Fail`${b(label)} storage roots must be absolute`;
    // eslint-disable-next-line no-await-in-loop
    const guest = await resolveFuturePath(root, label);
    const relative = path.relative(canonical, guest);
    const reverse = path.relative(guest, canonical);
    /** @param {string} value */
    const outside = value =>
      value === '..' || value.startsWith(`..${path.sep}`);
    (outside(relative) && outside(reverse)) ||
      Fail`Sandbox runtime directory must be disjoint from ${b(label)} guest storage roots`;
  }
  return canonical;
};
harden(assertRuntimePlacement);

/**
 * Persist only the explicit runtime construction policy; no ambient credentials.
 * @param {Record<string, string | undefined>} env
 * @param {string} ownerId
 * @param {Record<string, string>} roots
 * @param {string} [label]
 */
export const prepareRuntimeEnv = async (env, ownerId, roots, label) => {
  const config = readRuntimeConfig({ ...env, ENDO_SANDBOX_OWNER_ID: ownerId });
  const directory = await assertRuntimePlacement(
    config.directory,
    roots,
    label,
  );
  return harden({
    ENDO_SANDBOX_RUNTIME_DIR: directory,
    ENDO_SANDBOX_OWNER_ID: config.ownerId,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: String(config.maxBytes),
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: String(config.maxEntries),
  });
};
harden(prepareRuntimeEnv);

/**
 * A runtime claims `<owner>.owner` and `<owner>.files` in its directory at
 * construction and refuses either if present; a retired runtime under the
 * same label leaves both behind across restart or failed cleanup, and a
 * formula the daemon binds before construction would then be retained
 * unusable. Neither is adopted or removed here: the operator establishes that
 * the holder has stopped, then reconciles them, before setup mints anything.
 * @param {string} directory The canonical runtime directory.
 * @param {string} ownerId
 */
export const assertNoRuntimeLeftovers = async (directory, ownerId) => {
  for (const suffix of ['owner', 'files']) {
    const leftover = path.join(directory, `${ownerId}.${suffix}`);
    // eslint-disable-next-line no-await-in-loop
    const info = await fs.lstat(leftover).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (info !== undefined) {
      throw Fail`Runtime directory still holds ${q(leftover)}: the native runtime would claim it and be refused at construction. Establish that the runtime that held it has stopped, then reconcile it, before rerunning setup.`;
    }
  }
};
harden(assertNoRuntimeLeftovers);

/**
 * Create a private directory the daemon user owns, or adopt an existing one it
 * already owns, normalizing its mode; refuse a symlink, a non-directory, or a
 * directory owned by someone else.
 * @param {string} label The setting's name for messages.
 * @param {string} directory
 */
export const providePrivateDirectory = async (label, directory) => {
  const info = await fs.lstat(directory).catch(() => undefined);
  !info?.isSymbolicLink() ||
    Fail`${b(label)} must not be a symlink: ${q(directory)}`;
  if (info && !info.isDirectory()) {
    throw Fail`${b(label)} must be a directory: ${q(directory)}`;
  }
  if (info) {
    (await fs.stat(directory)).uid === process.getuid?.() ||
      Fail`${b(label)} must be owned by the daemon user: ${q(directory)}`;
    await fs.chmod(directory, 0o700);
  } else {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
};
harden(providePrivateDirectory);

/**
 * Mint an unconfined formula whose sole powers is an existing capability
 * named by path. `powersName` takes one pet name, so alias the capability
 * under a temporary root name for the mint; the formula retains the
 * capability's identity, not the alias. The temporary name should carry a
 * dot so it cannot shadow a managed-credential name.
 * @param {any} hostAgent
 * @param {object} options
 * @param {string[]} options.powersPath
 * @param {string} options.temporary
 * @param {string} options.specifier
 * @param {string[]} options.resultName
 * @param {Record<string, string>} options.env
 */
export const mintWithPowersPath = async (
  hostAgent,
  { powersPath, temporary, specifier, resultName, env },
) => {
  if (await E(hostAgent).has(temporary)) await E(hostAgent).remove(temporary);
  try {
    await E(hostAgent).copy(powersPath, [temporary]);
    await E(hostAgent).makeUnconfined('@main', specifier, {
      powersName: temporary,
      resultName,
      env: harden(env),
    });
  } finally {
    await E(hostAgent).remove(temporary);
  }
};
harden(mintWithPowersPath);

/**
 * The spelling checks of a configured slice image that need no Podman — the
 * digest a broker or controller refuses at construction, and an option-like
 * name Podman would misparse — so setup refuses them before any mint.
 * @param {string} rootfs Config rootfs (`oci:<image>` or already pinned).
 * @param {string} [label]
 * @returns {{ image: string, imageDigest?: string }}
 */
export const readSliceImageReference = (rootfs, label = 'Hosted') => {
  const image = rootfs.startsWith('oci:') ? rootfs.slice(4) : rootfs;
  // A leading dash would be parsed as a podman option rather than an image.
  !image.startsWith('-') || Fail`Invalid ${b(label)} sandbox image ${q(image)}`;
  if (image.includes('@sha256:')) {
    const imageDigest = image.slice(image.indexOf('@') + 1);
    /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
      Fail`${b(label)} sandbox image digest is invalid, got ${q(imageDigest)}`;
    return harden({ image, imageDigest });
  }
  return harden({ image });
};
harden(readSliceImageReference);

const execFile = promisify(execFileCallback);

/**
 * Resolve a local OCI image reference to its immutable digest form, so the
 * host pins what Podman actually resolved rather than trusting a mutable tag.
 *
 * @param {string} rootfs Config rootfs (`oci:<image>` or already pinned).
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [exec]
 * @param {string} [label]
 * @returns {Promise<{ imageRef: string, imageDigest: string }>}
 */
export const resolvePinnedImageRef = async (
  rootfs,
  exec = execFile,
  label = 'Hosted',
) => {
  const { image, imageDigest: pinned } = readSliceImageReference(rootfs, label);
  if (pinned !== undefined) {
    return harden({ imageRef: image, imageDigest: pinned });
  }
  const { stdout } = await exec('podman', [
    'image',
    'inspect',
    '--format',
    '{{.Digest}}',
    image,
  ]);
  const imageDigest = stdout.trim();
  /^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
    Fail`Cannot resolve a digest for ${b(label)} sandbox image ${q(image)}; build it before hosted setup`;
  // Drop the tag the image was FOUND under before pinning it. `name:tag@digest`
  // is valid reference syntax and Podman accepts it, but the native runtime's
  // PINNED_IMAGE_REFERENCE_PATTERN admits a registry port and no tag, so
  // appending the digest to the tagged name produced a reference that this
  // resolver called pinned and that every buildSlice then refused with "Native
  // profile requires a pinned OCI image". The digest is the pin; the tag it was
  // reached by is exactly the mutable part being resolved away.
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  const repository = lastColon > lastSlash ? image.slice(0, lastColon) : image;
  const imageRef = `${repository}@${imageDigest}`;
  // Check the rule the runtime will apply, here, where the operator can still
  // read the message — rather than shipping a value that only fails per
  // session, deep inside a slice build.
  PINNED_IMAGE_REFERENCE_PATTERN.test(imageRef) ||
    Fail`Resolved ${b(label)} sandbox image ${q(imageRef)} is not a pinned reference the native runtime will accept`;
  return harden({ imageRef, imageDigest });
};
harden(resolvePinnedImageRef);

/**
 * A retained broker keeps the slice and listener images it was minted with:
 * sessions record the broker's pins, and the controller attests a slice
 * against them. Setup therefore cannot re-pin a live broker in place, and
 * silently retaining it discards the operator's change — the unit environment
 * carries the new digest while every slice keeps launching the old image, and
 * nothing short of inspecting a running container says so. Refuse instead,
 * naming both digests and the retirement recipe, before any mint.
 *
 * Only the images are compared here. The rest of the persisted profile is
 * still retained as-is; a broker bearing live grants is deliberately not
 * rebuilt for a diagnostics toggle.
 *
 * @param {object} args
 * @param {string} args.label Adapter label for messages, e.g. `Claude`.
 * @param {string} args.serviceName Pet-name path of the broker, for the recipe.
 * @param {{ imageDigest: string, listenerImageRef: string }} args.retained
 *   The broker's persisted configuration.
 * @param {string} args.rootfs The configured slice image (`oci:<image>`).
 * @param {string} args.listenerImageRef The configured listener image, or ''
 *   when the environment names none (a retained broker needs none).
 * @param {(file: string, args: string[]) => Promise<{ stdout: string }>} [args.exec]
 */
export const assertRetainedBrokerImages = async ({
  label,
  serviceName,
  retained,
  rootfs,
  listenerImageRef,
  exec = undefined,
}) => {
  await null;
  // Resolving an unpinned tag asks Podman, which is read-only; a pinned
  // reference needs no Podman at all.
  const { imageDigest } = await resolvePinnedImageRef(rootfs, exec, label);
  imageDigest === retained.imageDigest ||
    Fail`The retained ${q(serviceName)} pins ${b(label)} sandbox image ${q(retained.imageDigest)} but the configuration now names ${q(imageDigest)}; a live broker cannot be re-pinned in place: remove ${q(serviceName)} when no session depends on it, then rerun setup to mint it with the current pins`;
  if (listenerImageRef !== '') {
    listenerImageRef === retained.listenerImageRef ||
      Fail`The retained ${q(serviceName)} runs listener image ${q(retained.listenerImageRef)} but the configuration now names ${q(listenerImageRef)}; a live broker cannot be re-pinned in place: remove ${q(serviceName)} when no session depends on it, then rerun setup to mint it with the current pins`;
  }
};
harden(assertRetainedBrokerImages);
