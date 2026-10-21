// @ts-nocheck
/* eslint-disable no-continue -- the URL resolver skips dot segments in a
   flat loop. */
/* global globalThis */

/**
 * Environment set-up for the `endor run <entry.js>` compartment mapper
 * bundle (`endor-run-mapper-xs.js`).
 *
 * The entry module imports this module first, so it evaluates before any
 * `@endo/compartment-mapper` module. Importing the XS variant of SES
 * (selected by the `xs` bundling condition) replaces
 * `globalThis.Compartment` with the SES adapter that drives the shim module
 * loader over native XS compartments; this module then installs the
 * `file:` URL subset the compartment mapper needs.
 *
 * The mapper machine does not lock down. It only loads and analyzes module
 * sources and never executes them (the application runs in a separate
 * machine), and lockdown would freeze `ModuleSource.prototype` before
 * `@endo/module-source` can add its `imports`/`exports` accessors.
 */

import 'ses';

// ---------------------------------------------------------------------------
// URL polyfill — RFC 3986 reference resolution for hierarchical URLs
// ---------------------------------------------------------------------------
//
// XS has no URL constructor. The compartment mapper resolves package and
// module locations with `new URL(relative, base)` and reads `href`,
// `pathname`, and `protocol`, all on `file:` URLs.

const urlPattern =
  /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;
const referencePattern = /^(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/;

/** @param {string} path */
const removeDotSegments = path => {
  const input = path.split('/');
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const segment = input[index];
    const last = index === input.length - 1;
    if (segment === '.') {
      if (last) output.push('');
      continue;
    }
    if (segment === '..') {
      if (output.length > 1) output.pop();
      if (last) output.push('');
      continue;
    }
    output.push(segment);
  }
  return output.join('/');
};

/**
 * @param {string} basePath
 * @param {boolean} hasAuthority
 * @param {string} referencePath
 */
const mergePaths = (basePath, hasAuthority, referencePath) => {
  if (hasAuthority && basePath === '') {
    return `/${referencePath}`;
  }
  return `${basePath.slice(0, basePath.lastIndexOf('/') + 1)}${referencePath}`;
};

class URLPolyfill {
  /**
   * @param {string} input
   * @param {string | URLPolyfill} [base]
   */
  constructor(input, base) {
    const text = String(input);
    let parts = urlPattern.exec(text);
    if (parts === null) {
      if (base === undefined) {
        throw TypeError(`Invalid URL: ${text}`);
      }
      const baseParts = urlPattern.exec(String(base));
      const referenceParts = referencePattern.exec(text);
      if (baseParts === null || referenceParts === null) {
        throw TypeError(`Invalid URL: ${text} against ${base}`);
      }
      const [, scheme, baseAuthority, basePath, baseQuery] = baseParts;
      const [, authority, path, query, fragment] = referenceParts;
      if (authority !== undefined) {
        parts = [
          text,
          scheme,
          authority,
          removeDotSegments(path),
          query,
          fragment,
        ];
      } else if (path === '') {
        parts = [
          text,
          scheme,
          baseAuthority,
          basePath,
          query ?? baseQuery,
          fragment,
        ];
      } else if (path.startsWith('/')) {
        parts = [
          text,
          scheme,
          baseAuthority,
          removeDotSegments(path),
          query,
          fragment,
        ];
      } else {
        const merged = mergePaths(basePath, baseAuthority !== undefined, path);
        parts = [
          text,
          scheme,
          baseAuthority,
          removeDotSegments(merged),
          query,
          fragment,
        ];
      }
    }
    const [, scheme, authority, path, query = '', fragment = ''] = parts;
    this.protocol = `${scheme.toLowerCase()}:`;
    // `file:` URLs always carry an (empty) authority, as WHATWG URL does.
    this.host = authority ?? '';
    this.hostname = this.host;
    this.pathname =
      this.protocol === 'file:' && !path.startsWith('/') ? `/${path}` : path;
    this.search = query === '?' ? '' : query;
    this.hash = fragment === '#' ? '' : fragment;
    const slashes =
      authority !== undefined || this.protocol === 'file:' ? '//' : '';
    this.href = `${this.protocol}${slashes}${this.host}${this.pathname}${this.search}${this.hash}`;
  }

  toString() {
    return this.href;
  }

  toJSON() {
    return this.href;
  }
}

if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = URLPolyfill;
}
