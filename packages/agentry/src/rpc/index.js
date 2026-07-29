// @ts-check

// The stdio JSONL RPC bridge: a language-agnostic, LF-delimited JSON surface
// that lets a spawned child drive a `PiAgent` over stdin and stdout, per
// `designs/endopi-stdio-rpc-bridge.md`. Harness infrastructure shared across
// endo agent packages — a genie-flavored runnable lives in `@endo/genie`
// (`rpc.js`), which wires its own agent to these building blocks.

export { makeJsonlDecoder, encodeRecord } from './framing.js';

export { translateAgentEvent } from './protocol.js';

export { makeRpcBridge } from './bridge.js';

export { makeRpcSession } from './session.js';

export { serveRpc } from './serve.js';
