/* global process */
import 'ses';
import fs from 'fs';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { fileURLToPath, pathToFileURL } from 'url';

const resolve = (rel, abs) => fileURLToPath(new URL(rel, abs).toString());
const root = new URL('..', import.meta.url).toString();

const read = async location => fs.promises.readFile(fileURLToPath(location));
const write = async (target, content) => {
  const location = resolve(target, root);
  await fs.promises.writeFile(location, content);
};

// When the node prelude runs inside the test262-harness's eshost VM context
// (which is a bare vm.createContext with only setTimeout, require, console,
// and print), TextEncoder and TextDecoder are absent.  Both @endo/utf8/src/
// encode.js and decode.js capture them at module-initialization time — before
// any user code runs — so the captures fail with ReferenceError.
//
// A naive fix of installing require('util').TextEncoder directly on globalThis
// would introduce a cross-realm problem: the host's TextEncoder produces
// Uint8Arrays backed by host-realm ArrayBuffers, but the immutable-arraybuffer
// shim installs sliceToImmutable on the VM-realm ArrayBuffer.prototype.
// Host-realm buffers do not gain sliceToImmutable, so calling toBytes() on a
// Uint8Array produced by the host TextEncoder would throw.
//
// The fix: install thin wrappers around the host TextEncoder and TextDecoder
// that copy any byte data into VM-realm Uint8Arrays (using globalThis.Uint8Array,
// which IS in the VM context via ArrayBuffer intrinsics).  This ensures every
// ArrayBuffer seen by the bundled pass-style modules is a VM-realm buffer and
// therefore has the shim's methods on its prototype.
//
// This preamble is a no-op when TextEncoder/TextDecoder are already present
// (i.e., in a standard Node.js environment that is not the eshost VM context).
const nodePreludeHeader = `\
if (typeof TextEncoder === "undefined") {
  var _util = require("util");
  var _buffer = require("buffer");
  var _hostTextEncoder = new _util.TextEncoder();
  var _hostTextDecoder = new _util.TextDecoder();
  var _hostFatalTextDecoder = new _util.TextDecoder("utf-8", { fatal: true });
  // Wrap TextEncoder: copy host output into a VM-realm Uint8Array so that
  // toBytes() (which calls buf.sliceToImmutable) sees a VM-realm ArrayBuffer.
  globalThis.TextEncoder = function TextEncoder() {};
  globalThis.TextEncoder.prototype.encode = function encode(s) {
    var hostBytes = _hostTextEncoder.encode(s);
    var vmBytes = new Uint8Array(hostBytes.length);
    for (var i = 0; i < hostBytes.length; i++) vmBytes[i] = hostBytes[i];
    return vmBytes;
  };
  globalThis.TextEncoder.prototype.encoding = "utf-8";
  // Wrap TextDecoder: copy VM-realm input into a host-realm Buffer before
  // decoding.  The input may be backed by an immutable VM-realm ArrayBuffer
  // that the host decoder cannot read directly.
  globalThis.TextDecoder = function TextDecoder(label, options) {
    this._fatal = options && options.fatal;
  };
  globalThis.TextDecoder.prototype.decode = function decode(input) {
    var decoder = this._fatal ? _hostFatalTextDecoder : _hostTextDecoder;
    var isFatal = this._fatal;
    // Copy bytes element-by-element into a host-realm Buffer so the host
    // decoder accepts the data regardless of the input's realm or mutability.
    if (input !== undefined) {
      var src;
      if (input instanceof Uint8Array) {
        src = input;
      } else if (input && typeof input.byteLength === "number") {
        src = new Uint8Array(input.byteLength);
        // Use DataView for cross-realm ArrayBuffer reading.
        var dv = new DataView(
          input.buffer || input,
          input.byteOffset || 0,
          input.byteLength
        );
        for (var i = 0; i < src.length; i++) src[i] = dv.getUint8(i);
      } else {
        src = new Uint8Array(0);
      }
      var hostBuf = _buffer.Buffer.allocUnsafe(src.length);
      for (var j = 0; j < src.length; j++) hostBuf[j] = src[j];
      try {
        return decoder.decode(hostBuf);
      } catch (e) {
        // Re-throw as a VM-realm TypeError so assert.throws(TypeError, ...)
        // sees thrown.constructor === globalThis.TypeError (not the host
        // realm's TypeError, which is a different object).
        if (isFatal) throw new TypeError(e.message);
        throw e;
      }
    }
    try {
      return decoder.decode();
    } catch (e) {
      if (isFatal) throw new TypeError(e.message);
      throw e;
    }
  };
  globalThis.TextDecoder.prototype.encoding = "utf-8";
}
`;

const main = async () => {
  const nodePreludeBundle = await makeBundle(
    read,
    pathToFileURL(
      resolve('../src/node-prelude.js', import.meta.url),
    ).toString(),
  );
  const nodePrelude = nodePreludeHeader + nodePreludeBundle;
  const xsPrelude = await makeBundle(
    read,
    pathToFileURL(resolve('../src/xs-prelude.js', import.meta.url)).toString(),
  );

  await fs.promises.mkdir('prelude', { recursive: true });
  await write('prelude/node.js', nodePrelude);
  await write('prelude/xs.js', xsPrelude);
};

main().catch(err => {
  console.error('Error running main:', err);
  process.exitCode = 1;
});
