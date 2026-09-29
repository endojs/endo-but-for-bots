// @ts-check
/* eslint-disable no-underscore-dangle -- `_id` and `_attachments` are npm
   registry wire field names. */

import { Buffer } from 'node:buffer';

import { q } from '@endo/errors';
import { RegistryHttpError, isRegistryHttpError } from './errors.js';
import { makeNodeFetch } from './node-fetch.js';
import {
  allowlistCovers,
  encodePackageName,
  tarballFileName,
} from './names.js';
import {
  compareSemver,
  devDateTagForVersion,
  isDateTag,
  isWritableDevTag,
  parseSemver,
} from './dev-release.js';
import {
  defaultArchiveLimits,
  digestTarball,
  ingestTarball,
  verifyTarball,
} from './tarball.js';

/** @import { FileCas } from './cas.js' */
/** @import { RegistryStore } from './store.js' */
/** @import { Grants, PublishGrant } from './grants.js' */
/** @import { ArchiveLimits } from './tarball.js' */
/** @import { UpstreamFetch, UpstreamResponse } from './node-fetch.js' */

/**
 * Fields npm's abbreviated install metadata
 * (`application/vnd.npm.install-v1+json`) keeps per version.
 */
const ABBREVIATED_FIELDS = harden([
  'name',
  'version',
  'deprecated',
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'acceptDependencies',
  'bin',
  'directories',
  'dist',
  'engines',
  'os',
  'cpu',
  'libc',
  'funding',
  'license',
  '_hasShrinkwrap',
  'hasInstallScript',
]);

/** Dependency fields whose publish-document spelling must match the tarball. */
const GRAPH_FIELDS = harden([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
]);

/**
 * Stable JSON with sorted object keys, for comparing manifests.
 *
 * @param {unknown} value
 * @returns {string}
 */
const canonicalJson = value =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  ) ?? 'undefined';

/**
 * Release an upstream response body that will not be read.
 *
 * @param {UpstreamResponse} response
 */
const discard = response => {
  const body = /** @type {any} */ (response.body);
  if (body && typeof body.destroy === 'function') {
    body.destroy();
  } else if (body && typeof body.cancel === 'function') {
    body.cancel().catch(() => {});
  }
};

/**
 * @param {UpstreamResponse} response
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 */
const readLimited = async (response, maxBytes) => {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    discard(response);
    throw RegistryHttpError(502, 'Upstream response exceeds the size limit');
  }
  if (!response.body) {
    return new Uint8Array(0);
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
      /** @type {unknown} */ (response.body)
    )) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw RegistryHttpError(
          502,
          'Upstream response exceeds the size limit',
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (isRegistryHttpError(error)) {
      throw error;
    }
    // A connection reset or timeout mid-body is an upstream failure like
    // any other, not an internal error.
    const timedOut = /** @type {Error} */ (error).name === 'TimeoutError';
    throw RegistryHttpError(
      timedOut ? 504 : 502,
      'Upstream response was interrupted',
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * @param {string} data
 * @returns {Uint8Array}
 */
const decodeBase64 = data => {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
    throw RegistryHttpError(400, 'Attachment data is not base64');
  }
  return new Uint8Array(Buffer.from(data, 'base64'));
};

/**
 * @typedef {object} RegistryOptions
 * @property {RegistryStore} store
 * @property {FileCas} cas
 * @property {Grants} grants
 * @property {string} publicOrigin Origin (and optional path prefix) that
 *   served tarball URLs are rooted at, e.g. `https://npm.minion.town`.
 * @property {string} [upstreamOrigin] The single pinned upstream registry;
 *   omit for a local-only registry.
 * @property {UpstreamFetch} [fetch] Outbound HTTP power; defaults to a
 *   `node:http`/`node:https` client that never follows redirects.
 * @property {readonly string[]} [reservedTags] Moving `dev-*` pointers that
 *   `npm dist-tag add` may set besides the date channels.
 * @property {number} [upstreamTtlMs] Freshness of cached upstream metadata.
 * @property {number} [upstreamTimeoutMs]
 * @property {number} [maxPackumentBytes]
 * @property {ArchiveLimits} [limits]
 * @property {() => number} [now]
 */

/**
 * The reason a publish conflicts with a version row already present. A row
 * indexed from upstream is refused whatever its content, so only a
 * published row with a different integrity is reported as different
 * content.
 *
 * @param {string} name
 * @param {string} version
 * @param {{ source: string, integrity: string }} existing
 * @returns {string}
 */
const conflictReason = (name, version, existing) =>
  existing.source === 'published'
    ? `${name}@${version} already exists with different content`
    : `${name}@${version} already exists from the upstream registry`;

/**
 * The registry core: the publish transaction, dist-tag moves, packument
 * synthesis, and demand-filled upstream read-through. Every served tarball
 * URL is rooted at `publicOrigin`, and every tarball is served from the
 * CAS, so a client configured with this registry as its only registry never
 * sees another origin.
 *
 * @param {RegistryOptions} options
 */
export const makeRegistry = ({
  store,
  cas,
  grants,
  publicOrigin,
  upstreamOrigin,
  fetch = makeNodeFetch(),
  reservedTags = ['dev-latest'],
  upstreamTtlMs = 5 * 60 * 1000,
  upstreamTimeoutMs = 30 * 1000,
  maxPackumentBytes = 64 * 1024 * 1024,
  limits = defaultArchiveLimits,
  now = Date.now,
}) => {
  const { statements } = store;
  const origin = publicOrigin.replace(/\/+$/u, '');
  const upstream = upstreamOrigin?.replace(/\/+$/u, '');
  if (upstream !== undefined && !/^https?:\/\/[^/]+(\/.*)?$/u.test(upstream)) {
    throw Error(`Invalid upstream origin ${q(upstreamOrigin)}`);
  }

  /**
   * @param {PublishGrant | undefined} grant
   * @param {string} name
   * @param {string} action
   * @returns {PublishGrant}
   */
  const authorize = (grant, name, action) => {
    if (!grant) {
      throw RegistryHttpError(401, `Authentication required to ${action}`);
    }
    if (!allowlistCovers(grant.packages, name)) {
      throw RegistryHttpError(
        403,
        `Grant ${q(grant.id)} does not cover package ${q(name)}`,
      );
    }
    return grant;
  };

  /**
   * Re-check, inside the storage transaction, that the grant is still live,
   * still held under the same token, and still covers the package. The row
   * is found by the credential, not by the grant's id, so a token rotated
   * while a publish was awaiting its tarball cannot finish that publish.
   *
   * @param {PublishGrant} grant
   * @param {string} name
   */
  const recheckGrant = (grant, name) => {
    const row = statements.getGrantByToken.get(grant.tokenSha256);
    if (
      !row ||
      row.id !== grant.id ||
      row.subject !== grant.subject ||
      row.revoked_at !== null ||
      Number(row.expires_at) <= now() ||
      !allowlistCovers(JSON.parse(row.packages_json), name)
    ) {
      throw RegistryHttpError(403, `Grant ${q(grant.id)} is no longer live`);
    }
  };

  /**
   * @param {string} subject
   * @param {string} action
   * @param {string} name
   * @param {string | null} version
   * @param {string | null} tag
   * @param {string} outcome
   * @param {string | null} [integrity]
   * @param {string | null} [detail]
   */
  const audit = (
    subject,
    action,
    name,
    version,
    tag,
    outcome,
    integrity = null,
    detail = null,
  ) => {
    statements.audit.run(
      now(),
      subject,
      action,
      name,
      version,
      tag,
      outcome,
      integrity,
      detail,
    );
  };

  /**
   * Refuse a tag move that would point a channel at an older version.
   *
   * @param {string} name
   * @param {string} tag
   * @param {string} version
   */
  const checkMonotonic = (name, tag, version) => {
    const current = statements.getTag.get(name, tag);
    if (
      current &&
      current.source === 'published' &&
      compareSemver(version, current.version) < 0
    ) {
      throw RegistryHttpError(
        409,
        `Tag ${q(tag)} already points at newer ${q(current.version)}`,
      );
    }
  };

  /**
   * Accept one `npm publish` document for a development version.
   *
   * @param {PublishGrant | undefined} maybeGrant
   * @param {string} name canonical package name from the request path
   * @param {any} document the npm publish body
   * @returns {Promise<{ version: string, tag: string, integrity: string, created: boolean }>}
   */
  const publish = async (maybeGrant, name, document) => {
    const grant = authorize(maybeGrant, name, 'publish');
    const refuse = (/** @type {string} */ reason) => {
      audit(
        grant.subject,
        'publish',
        name,
        null,
        null,
        'refused',
        null,
        reason,
      );
      return RegistryHttpError(400, reason);
    };
    if (!document || typeof document !== 'object') {
      throw refuse('Publish body must be a JSON object');
    }
    if (
      document.name !== name ||
      (document._id !== undefined && document._id !== name)
    ) {
      throw refuse(`Publish document names do not match ${q(name)}`);
    }
    const versions = Object.keys(document.versions ?? {});
    const attachments = Object.keys(document._attachments ?? {});
    if (versions.length !== 1 || attachments.length !== 1) {
      throw refuse('Publish must carry exactly one version and one tarball');
    }
    const [version] = versions;
    const expectedTag = devDateTagForVersion(version);
    const tags = Object.entries(document['dist-tags'] ?? {});
    if (
      tags.length !== 1 ||
      tags[0][0] !== expectedTag ||
      tags[0][1] !== version
    ) {
      throw refuse(
        `Publish must carry exactly the tag ${q(expectedTag)} for ${q(version)} (npm publish --tag ${expectedTag})`,
      );
    }
    const manifest = document.versions[version];
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      manifest.name !== name ||
      manifest.version !== version
    ) {
      throw refuse('Version manifest name/version do not match');
    }
    const attachment = document._attachments[attachments[0]];
    const tarball = decodeBase64(attachment?.data);
    if (tarball.byteLength > limits.maxTarballBytes) {
      throw RegistryHttpError(413, 'Tarball exceeds the compressed size limit');
    }
    if (
      attachment.length !== undefined &&
      attachment.length !== tarball.byteLength
    ) {
      throw refuse('Attachment length does not match its data');
    }

    const { integrity, shasum } = digestTarball(tarball);
    const existing = statements.getVersion.get(name, version);
    if (existing) {
      if (existing.source === 'published' && existing.integrity === integrity) {
        audit(
          grant.subject,
          'publish',
          name,
          version,
          expectedTag,
          'noop',
          integrity,
        );
        return { version, tag: expectedTag, integrity, created: false };
      }
      audit(
        grant.subject,
        'publish',
        name,
        version,
        expectedTag,
        'conflict',
        integrity,
      );
      throw RegistryHttpError(409, conflictReason(name, version, existing));
    }

    // CAS writes precede the visibility transaction.
    const { tarballHash, treeHash, packageJson } = await ingestTarball(
      tarball,
      { cas, limits },
    );
    if (packageJson.name !== name || packageJson.version !== version) {
      throw refuse('Tarball package.json name/version do not match');
    }
    for (const field of GRAPH_FIELDS) {
      if (
        canonicalJson(manifest[field]) !== canonicalJson(packageJson[field])
      ) {
        throw refuse(
          `Publish manifest ${field} differ from the tarball package.json`,
        );
      }
    }
    const stored = {
      ...manifest,
      _npmUser: { name: grant.subject },
      dist: { integrity, shasum },
    };
    delete stored.readme;

    return store.transaction(() => {
      recheckGrant(grant, name);
      const raced = statements.getVersion.get(name, version);
      if (raced) {
        if (raced.integrity === integrity && raced.source === 'published') {
          return { version, tag: expectedTag, integrity, created: false };
        }
        throw RegistryHttpError(409, conflictReason(name, version, raced));
      }
      checkMonotonic(name, expectedTag, version);
      const at = now();
      statements.insertVersion.run(
        name,
        version,
        JSON.stringify(stored),
        integrity,
        shasum,
        'published',
        at,
      );
      statements.insertPackage.run(
        name,
        version,
        treeHash,
        tarballHash,
        integrity,
        shasum,
        at,
      );
      statements.setPublishedTag.run(name, expectedTag, version, at);
      audit(
        grant.subject,
        'publish',
        name,
        version,
        expectedTag,
        'ok',
        integrity,
      );
      return { version, tag: expectedTag, integrity, created: true };
    });
  };

  /**
   * `npm dist-tag add name@version tag`.
   *
   * @param {PublishGrant | undefined} maybeGrant
   * @param {string} name
   * @param {string} tag
   * @param {unknown} version
   */
  const setDistTag = (maybeGrant, name, tag, version) => {
    const grant = authorize(maybeGrant, name, 'set a dist-tag');
    if (typeof version !== 'string') {
      throw RegistryHttpError(400, 'Dist-tag body must be a version string');
    }
    if (!isWritableDevTag(tag, reservedTags)) {
      audit(grant.subject, 'dist-tag', name, version, tag, 'refused');
      throw RegistryHttpError(
        403,
        `Tag ${q(tag)} is not a writable development tag`,
      );
    }
    if (isDateTag(tag) && devDateTagForVersion(version) !== tag) {
      throw RegistryHttpError(
        400,
        `Tag ${q(tag)} may only point at versions from that date`,
      );
    }
    return store.transaction(() => {
      recheckGrant(grant, name);
      const row = statements.getVersion.get(name, version);
      if (!row || row.source !== 'published') {
        throw RegistryHttpError(
          404,
          `No published development version ${name}@${version}`,
        );
      }
      checkMonotonic(name, tag, version);
      statements.setPublishedTag.run(name, tag, version, now());
      audit(grant.subject, 'dist-tag', name, version, tag, 'ok', row.integrity);
      return { [tag]: version };
    });
  };

  /** @type {Map<string, Promise<void>>} */
  const metaInFlight = new Map();

  /**
   * Index an upstream packument's versions and tags. Local published rows
   * are authoritative: upstream rows never replace them.
   *
   * @param {string} name
   * @param {any} document
   * @param {string | null} etag
   */
  const indexUpstream = (name, document, etag) => {
    if (
      !document ||
      typeof document !== 'object' ||
      document.name !== name ||
      typeof document.versions !== 'object'
    ) {
      throw RegistryHttpError(
        502,
        `Upstream packument for ${q(name)} is invalid`,
      );
    }
    store.transaction(() => {
      const at = now();
      for (const [version, manifest] of Object.entries(document.versions)) {
        if (
          parseSemver(version) &&
          manifest &&
          typeof manifest === 'object' &&
          manifest.dist &&
          (typeof manifest.dist.integrity === 'string' ||
            typeof manifest.dist.shasum === 'string')
        ) {
          const { dist } = manifest;
          const kept = { ...manifest, dist: undefined };
          statements.insertVersion.run(
            name,
            version,
            JSON.stringify(kept),
            typeof dist.integrity === 'string' ? dist.integrity : '',
            typeof dist.shasum === 'string' ? dist.shasum : '',
            'upstream',
            at,
          );
        }
      }
      for (const [tag, version] of Object.entries(
        document['dist-tags'] ?? {},
      )) {
        if (
          typeof version === 'string' &&
          statements.getVersion.get(name, version)
        ) {
          statements.setUpstreamTag.run(name, tag, version, at);
        }
      }
      statements.upsertMeta.run(
        name,
        JSON.stringify({ modified: document.modified ?? null }),
        etag,
        at + upstreamTtlMs,
        at,
      );
    });
  };

  /**
   * Refresh upstream metadata for a package when it is stale. Concurrent
   * misses for one package share one request. A failure with metadata
   * already cached serves the cached rows (stale-if-error); a failure with
   * nothing cached is a bounded 502/504, never a redirect.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  const refreshUpstream = name => {
    if (upstream === undefined) {
      return Promise.resolve();
    }
    const meta = statements.getMeta.get(name);
    if (meta && Number(meta.expires_at) > now()) {
      return Promise.resolve();
    }
    const pending = metaInFlight.get(name);
    if (pending) {
      return pending;
    }
    const work = (async () => {
      /** @type {Record<string, string>} */
      const headers = {
        accept:
          'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      };
      if (meta?.upstream_etag) {
        headers['if-none-match'] = meta.upstream_etag;
      }
      /** @type {UpstreamResponse} */
      let response;
      try {
        response = await fetch(`${upstream}/${encodePackageName(name)}`, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
      } catch (error) {
        if (meta) {
          return;
        }
        const timedOut = /** @type {Error} */ (error).name === 'TimeoutError';
        throw RegistryHttpError(
          timedOut ? 504 : 502,
          `Upstream metadata for ${q(name)} is unavailable`,
        );
      }
      if (!response.ok || response.status === 304) {
        discard(response);
      }
      if (response.status === 304 && meta) {
        statements.upsertMeta.run(
          name,
          meta.upstream_json,
          meta.upstream_etag,
          now() + upstreamTtlMs,
          now(),
        );
        return;
      }
      if (response.status === 404) {
        // Negative cache: this package exists only locally, if at all.
        statements.upsertMeta.run(
          name,
          null,
          null,
          now() + upstreamTtlMs,
          now(),
        );
        return;
      }
      if (!response.ok) {
        if (meta) {
          return;
        }
        throw RegistryHttpError(
          502,
          `Upstream metadata for ${q(name)} returned ${response.status}`,
        );
      }
      // Failures after the upstream starts replying (a truncated or
      // oversized body, a body that is not JSON, a packument for another
      // name) fall back to cached rows like any other upstream failure.
      try {
        const bytes = await readLimited(response, maxPackumentBytes);
        /** @type {any} */
        let document;
        try {
          document = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw RegistryHttpError(
            502,
            `Upstream packument for ${q(name)} is not JSON`,
          );
        }
        indexUpstream(name, document, response.headers.get('etag'));
      } catch (error) {
        if (meta) {
          return;
        }
        throw error;
      }
    })().finally(() => metaInFlight.delete(name));
    metaInFlight.set(name, work);
    return work;
  };

  /**
   * @param {string} name
   * @param {string} version
   * @param {any} row
   */
  const serveManifest = (name, version, row) => {
    const manifest = JSON.parse(row.manifest_json);
    /** @type {Record<string, string>} */
    const dist = {
      tarball: `${origin}/${encodePackageName(name)}/-/${tarballFileName(name, version)}`,
    };
    if (row.integrity) {
      dist.integrity = row.integrity;
    }
    if (row.shasum) {
      dist.shasum = row.shasum;
    }
    // Upstream signatures and attestations name another registry's keys;
    // only the content digests travel.
    return { ...manifest, _id: `${name}@${version}`, dist };
  };

  /**
   * @param {string} name
   * @param {{ abbreviated?: boolean }} [options]
   */
  const getPackument = async (name, { abbreviated = false } = {}) => {
    await refreshUpstream(name);
    const rows = statements.listVersions.all(name);
    if (rows.length === 0) {
      throw RegistryHttpError(404, `Package ${q(name)} not found`);
    }
    /** @type {Record<string, any>} */
    const versions = {};
    /** @type {Record<string, string>} */
    const time = {};
    let modified = 0;
    for (const row of rows) {
      const manifest = serveManifest(name, row.version, row);
      versions[row.version] = abbreviated
        ? Object.fromEntries(
            ABBREVIATED_FIELDS.filter(key => manifest[key] !== undefined).map(
              key => [key, manifest[key]],
            ),
          )
        : manifest;
      time[row.version] = new Date(row.indexed_at).toISOString();
      modified = Math.max(modified, row.indexed_at);
    }
    /** @type {Record<string, string>} */
    const distTags = {};
    for (const row of statements.listTags.all(name)) {
      distTags[row.tag] = row.version;
      modified = Math.max(modified, row.updated_at);
    }
    const modifiedIso = new Date(modified).toISOString();
    if (abbreviated) {
      return { name, modified: modifiedIso, 'dist-tags': distTags, versions };
    }
    return {
      _id: name,
      name,
      'dist-tags': distTags,
      versions,
      time: { ...time, modified: modifiedIso },
    };
  };

  /**
   * @param {string} name
   * @param {string} versionOrTag
   */
  const getVersionManifest = async (name, versionOrTag) => {
    await refreshUpstream(name);
    const tagRow = statements.getTag.get(name, versionOrTag);
    const version = tagRow ? tagRow.version : versionOrTag;
    const row = statements.getVersion.get(name, version);
    if (!row) {
      throw RegistryHttpError(404, `Version ${name}@${versionOrTag} not found`);
    }
    return serveManifest(name, version, row);
  };

  /** @param {string} name */
  const getDistTags = async name => {
    await refreshUpstream(name);
    const rows = statements.listTags.all(name);
    if (rows.length === 0 && statements.listVersions.all(name).length === 0) {
      throw RegistryHttpError(404, `Package ${q(name)} not found`);
    }
    return Object.fromEntries(rows.map(row => [row.tag, row.version]));
  };

  /** @type {Map<string, Promise<any>>} */
  const tarballInFlight = new Map();

  /**
   * Fetch, verify, retain, and extract an upstream tarball selected by a
   * client, then record its materialization row.
   *
   * @param {string} name
   * @param {string} version
   * @param {any} row the `package_versions` row
   */
  const materializeUpstream = (name, version, row) => {
    const key = `${name}@${version}`;
    const pending = tarballInFlight.get(key);
    if (pending) {
      return pending;
    }
    const work = (async () => {
      if (upstream === undefined) {
        throw RegistryHttpError(404, `Tarball for ${key} is not stored`);
      }
      // Reconstructed against the pinned origin; the packument's own
      // `dist.tarball` is never followed.
      const url = `${upstream}/${encodePackageName(name)}/-/${tarballFileName(name, version)}`;
      /** @type {UpstreamResponse} */
      let response;
      try {
        response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
      } catch (error) {
        const timedOut = /** @type {Error} */ (error).name === 'TimeoutError';
        throw RegistryHttpError(
          timedOut ? 504 : 502,
          `Upstream tarball for ${key} is unavailable`,
        );
      }
      if (!response.ok) {
        discard(response);
        throw RegistryHttpError(
          502,
          `Upstream tarball for ${key} returned ${response.status}`,
        );
      }
      const bytes = await readLimited(response, limits.maxTarballBytes);
      if (!verifyTarball(bytes, row)) {
        throw RegistryHttpError(
          502,
          `Upstream tarball for ${key} failed integrity verification`,
        );
      }
      /** @type {Awaited<ReturnType<typeof ingestTarball>>} */
      let ingested;
      try {
        ingested = await ingestTarball(bytes, { cas, limits });
      } catch (error) {
        throw RegistryHttpError(
          502,
          `Upstream tarball for ${key} was refused: ${/** @type {Error} */ (error).message}`,
        );
      }
      store.transaction(() => {
        statements.insertPackage.run(
          name,
          version,
          ingested.treeHash,
          ingested.tarballHash,
          row.integrity,
          row.shasum,
          now(),
        );
      });
      return statements.getPackage.get(name, version);
    })().finally(() => tarballInFlight.delete(key));
    tarballInFlight.set(key, work);
    return work;
  };

  /**
   * Resolve a tarball request to the exact stored bytes.
   *
   * @param {string} name
   * @param {string} file e.g. `patterns-1.7.0-dev.20260928231903.g3aa902d.tgz`
   * @returns {Promise<{ bytes: Uint8Array, tarballHash: string, integrity: string }>}
   */
  const getTarball = async (name, file) => {
    const base = tarballFileName(name, '').slice(0, -'.tgz'.length);
    if (!file.startsWith(base) || !file.endsWith('.tgz')) {
      throw RegistryHttpError(404, `No tarball ${q(file)} for ${q(name)}`);
    }
    const version = file.slice(base.length, -'.tgz'.length);
    if (!parseSemver(version)) {
      throw RegistryHttpError(404, `No tarball ${q(file)} for ${q(name)}`);
    }
    let row = statements.getVersion.get(name, version);
    if (!row) {
      await refreshUpstream(name);
      row = statements.getVersion.get(name, version);
    }
    if (!row) {
      throw RegistryHttpError(404, `Version ${name}@${version} not found`);
    }
    let materialized = statements.getPackage.get(name, version);
    if (!materialized) {
      if (row.source !== 'upstream') {
        throw RegistryHttpError(
          500,
          `Stored tarball for ${name}@${version} is missing`,
        );
      }
      materialized = await materializeUpstream(name, version, row);
    }
    return {
      bytes: cas.get(materialized.tarball_hash),
      tarballHash: materialized.tarball_hash,
      integrity: materialized.integrity,
    };
  };

  /**
   * Startup verification: every materialized version's tarball and tree
   * must be present. A non-empty result fails readiness.
   *
   * @returns {string[]} `name@version` coordinates missing content
   */
  const verifyStore = () =>
    statements.listPackages
      .all()
      .filter(row => !cas.has(row.tarball_hash) || !cas.has(row.tree_hash))
      .map(row => `${row.name}@${row.version}`);

  return harden({
    publish,
    setDistTag,
    getPackument,
    getVersionManifest,
    getDistTags,
    getTarball,
    verifyStore,
  });
};
harden(makeRegistry);

/** @typedef {ReturnType<typeof makeRegistry>} Registry */
