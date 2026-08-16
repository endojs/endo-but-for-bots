// WHATWG URL and URLSearchParams for the confined XS runtime.
//
// The classes are thin veneers over the host's spec-faithful parser
// (rust-url, the same WHATWG implementation the fetch layer already
// links) reached through four host functions:
//
//   hostUrlParse(href, base)      -> JSON url record | { error }
//   hostUrlSet(href, field, v)    -> JSON url record | { error }
//   hostFormUrlDecode(query)      -> JSON [[name, value], ...]
//   hostFormUrlEncode(pairsJson)  -> application/x-www-form-urlencoded
//
// A url record carries every WHATWG getter surface already in its
// serialized shape (protocol with the trailing ':', search with the
// leading '?', port '' when default, ...), so the JS side holds no
// parsing logic of its own. Setter semantics follow the spec: an
// invalid value is silently ignored, except for `href` which throws.
//
// Evaluated in machines that install npm archives; the classes are
// additionally endowed to archive compartments (__archiveEndowments).
// Guarded so an engine-provided URL is never displaced.
(function () {
  'use strict';
  if (
    typeof globalThis.URL !== 'undefined' &&
    typeof globalThis.URLSearchParams !== 'undefined'
  ) {
    return;
  }

  // Internal state lives in closure-scoped WeakMaps rather than
  // private fields so the URL/URLSearchParams linkage can cross the
  // two classes without exposing hooks on the instances.
  var urlRecord = new WeakMap(); // URL -> host url record
  var urlParams = new WeakMap(); // URL -> cached URLSearchParams
  var spList = new WeakMap(); // URLSearchParams -> [[name, value], ...]
  var spOwner = new WeakMap(); // URLSearchParams -> owner URL

  var parseOrThrow = function (href, base) {
    // '' is the host call's no-base sentinel, but an explicit empty
    // base is itself an unparsable URL and must throw.
    if (base !== undefined && String(base) === '') {
      throw new TypeError('Invalid URL: empty base');
    }
    var record = JSON.parse(
      hostUrlParse(String(href), base === undefined ? '' : String(base)),
    );
    if (record.error !== undefined) {
      throw new TypeError('Invalid URL: ' + record.error);
    }
    return record;
  };

  var decodeQuery = function (search) {
    var query = String(search);
    if (query.charAt(0) === '?') {
      query = query.slice(1);
    }
    return JSON.parse(hostFormUrlDecode(query));
  };

  // Re-derive an existing searchParams list after the owner URL's
  // query changed underneath it (search/href setter).
  var reinitParams = function (url) {
    var params = urlParams.get(url);
    if (params !== undefined) {
      spList.set(params, decodeQuery(urlRecord.get(url).search));
    }
  };

  // Apply one WHATWG setter through the host. Failures are silently
  // ignored (the spec's basic-URL-parse-with-state-override contract);
  // `href` is the one setter that throws, handled at its call site.
  var applySet = function (url, field, value) {
    var record = JSON.parse(
      hostUrlSet(urlRecord.get(url).href, field, String(value)),
    );
    if (record.error === undefined) {
      urlRecord.set(url, record);
      if (field === 'search') {
        reinitParams(url);
      }
    }
    return record;
  };

  // Push a mutated searchParams list back into its owner URL, if any.
  var updateOwner = function (params) {
    var url = spOwner.get(params);
    if (url !== undefined) {
      applySet(url, 'search', hostFormUrlEncode(JSON.stringify(spList.get(params))));
    }
  };

  class URLSearchParams {
    constructor(init) {
      var list = [];
      if (init !== undefined && init !== null) {
        if (typeof init === 'object') {
          if (spList.has(init)) {
            var source = spList.get(init);
            for (var i = 0; i < source.length; i += 1) {
              list.push([source[i][0], source[i][1]]);
            }
          } else if (typeof init[Symbol.iterator] === 'function') {
            for (var pair of init) {
              var entry = [];
              for (var item of pair) {
                entry.push(String(item));
              }
              if (entry.length !== 2) {
                throw new TypeError(
                  'URLSearchParams: each init pair must have two items',
                );
              }
              list.push(entry);
            }
          } else {
            var names = Object.keys(init);
            for (var j = 0; j < names.length; j += 1) {
              list.push([String(names[j]), String(init[names[j]])]);
            }
          }
        } else {
          list = decodeQuery(init);
        }
      }
      spList.set(this, list);
    }
    get size() {
      return spList.get(this).length;
    }
    append(name, value) {
      spList.get(this).push([String(name), String(value)]);
      updateOwner(this);
    }
    delete(name, value) {
      var key = String(name);
      var list = spList.get(this);
      for (var i = list.length - 1; i >= 0; i -= 1) {
        if (
          list[i][0] === key &&
          (value === undefined || list[i][1] === String(value))
        ) {
          list.splice(i, 1);
        }
      }
      updateOwner(this);
    }
    get(name) {
      var key = String(name);
      var list = spList.get(this);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i][0] === key) {
          return list[i][1];
        }
      }
      return null;
    }
    getAll(name) {
      var key = String(name);
      var out = [];
      var list = spList.get(this);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i][0] === key) {
          out.push(list[i][1]);
        }
      }
      return out;
    }
    has(name, value) {
      var key = String(name);
      var list = spList.get(this);
      for (var i = 0; i < list.length; i += 1) {
        if (
          list[i][0] === key &&
          (value === undefined || list[i][1] === String(value))
        ) {
          return true;
        }
      }
      return false;
    }
    set(name, value) {
      var key = String(name);
      var list = spList.get(this);
      var placed = false;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i][0] === key) {
          if (placed) {
            list.splice(i, 1);
            i -= 1;
          } else {
            list[i][1] = String(value);
            placed = true;
          }
        }
      }
      if (!placed) {
        list.push([key, String(value)]);
      }
      updateOwner(this);
    }
    sort() {
      // Stable, by name, comparing UTF-16 code units (the spec's
      // "code unit less than" — JS string comparison order).
      var list = spList.get(this);
      var indexed = list.map(function (entry, index) {
        return { entry, index };
      });
      indexed.sort(function (a, b) {
        if (a.entry[0] < b.entry[0]) return -1;
        if (a.entry[0] > b.entry[0]) return 1;
        return a.index - b.index;
      });
      for (var i = 0; i < indexed.length; i += 1) {
        list[i] = indexed[i].entry;
      }
      updateOwner(this);
    }
    forEach(callback, thisArg) {
      var list = spList.get(this);
      for (var i = 0; i < list.length; i += 1) {
        callback.call(thisArg, list[i][1], list[i][0], this);
      }
    }
    *entries() {
      var list = spList.get(this);
      for (var i = 0; i < list.length; i += 1) {
        yield [list[i][0], list[i][1]];
      }
    }
    *keys() {
      for (var pair of this.entries()) {
        yield pair[0];
      }
    }
    *values() {
      for (var pair of this.entries()) {
        yield pair[1];
      }
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return hostFormUrlEncode(JSON.stringify(spList.get(this)));
    }
  }

  class URL {
    constructor(url, base) {
      urlRecord.set(this, parseOrThrow(url, base));
    }
    static canParse(url, base) {
      try {
        parseOrThrow(url, base);
        return true;
      } catch (_error) {
        return false;
      }
    }
    static parse(url, base) {
      try {
        return new URL(url, base);
      } catch (_error) {
        return null;
      }
    }
    get href() {
      return urlRecord.get(this).href;
    }
    set href(value) {
      var record = applySet(this, 'href', value);
      if (record.error !== undefined) {
        throw new TypeError('Invalid URL: ' + record.error);
      }
      reinitParams(this);
    }
    get origin() {
      return urlRecord.get(this).origin;
    }
    get protocol() {
      return urlRecord.get(this).protocol;
    }
    set protocol(value) {
      applySet(this, 'protocol', value);
    }
    get username() {
      return urlRecord.get(this).username;
    }
    set username(value) {
      applySet(this, 'username', value);
    }
    get password() {
      return urlRecord.get(this).password;
    }
    set password(value) {
      applySet(this, 'password', value);
    }
    get host() {
      return urlRecord.get(this).host;
    }
    set host(value) {
      applySet(this, 'host', value);
    }
    get hostname() {
      return urlRecord.get(this).hostname;
    }
    set hostname(value) {
      applySet(this, 'hostname', value);
    }
    get port() {
      return urlRecord.get(this).port;
    }
    set port(value) {
      applySet(this, 'port', value);
    }
    get pathname() {
      return urlRecord.get(this).pathname;
    }
    set pathname(value) {
      applySet(this, 'pathname', value);
    }
    get search() {
      return urlRecord.get(this).search;
    }
    set search(value) {
      applySet(this, 'search', value);
    }
    get searchParams() {
      var params = urlParams.get(this);
      if (params === undefined) {
        params = new URLSearchParams(urlRecord.get(this).search);
        spOwner.set(params, this);
        urlParams.set(this, params);
      }
      return params;
    }
    get hash() {
      return urlRecord.get(this).hash;
    }
    set hash(value) {
      applySet(this, 'hash', value);
    }
    toString() {
      return urlRecord.get(this).href;
    }
    toJSON() {
      return urlRecord.get(this).href;
    }
  }

  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
})();
