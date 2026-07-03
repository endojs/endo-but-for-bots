// Alternative, Proxy-based freezable-TypedArray emulation, published for
// comparison with the shipped plain-object wrapper (see ./shim.js). This is a
// library layer only: it installs nothing on the primordials. See
// src/proxy-lib.js and designs/freezable-typedarray.md ("Why not a Proxy
// wrapper?").
export {
  isIntegerIndexKey,
  makeIndexRejectingProxy,
  makeFreezableIndexRejectingProxy,
  makeProxyPseudoTypedArrayConstructor,
} from './src/proxy-lib.js';
