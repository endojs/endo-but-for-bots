// @ts-check
// reexport-policy-exempt: this is the `@endo/agentry/rpc` entry point, not a
// compatibility shim; each name has no older home to deprecate.

export { makeJsonlDecoder, encodeRecord } from './framing.js';

export { translateAgentEvent } from './protocol.js';

export { makeRpcBridge } from './bridge.js';

export { makeRpcSession } from './session.js';

export { serveRpc } from './serve.js';
