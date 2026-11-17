// @ts-check
/// <reference types="ses"/>

// MCP (Model Context Protocol) projection of a static tool declaration.
//
// This module is transport-free: it validates a hardened, static tool
// declaration (the guest-agent interface) and answers decoded JSON-RPC 2.0
// messages against ONE bound target. A transport (for example the stdio server
// in `@endo/agent-mcp-stdio`) frames the messages and supplies the target.
// It adds no MCP runtime dependency.
//
// See designs/endo-guest-stdio-mcp.md for the contract: the static catalog, the
// server-side dispatch check, the construction discriminants, and the
// request-time error taxonomy.

import { makeError } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';
import { matches } from '@endo/patterns';

/**
 * @import {
 *   CatalogWarning,
 *   ConstructionError,
 *   ConstructionReason,
 *   JsonRpcResponse,
 *   McpTool,
 *   ToolCatalog,
 *   ToolDeclaration,
 * } from '../types.js'
 */

// #region Error codes

/** JSON-RPC 2.0: the frame was not valid JSON. */
export const PARSE_ERROR = -32_700;
/** JSON-RPC 2.0: the frame was JSON but not a valid request. */
export const INVALID_REQUEST = -32_600;
/** JSON-RPC 2.0: unknown method. */
export const METHOD_NOT_FOUND = -32_601;
/** JSON-RPC 2.0: invalid method parameters. */
export const INVALID_PARAMS = -32_602;
/** JSON-RPC 2.0: the server failed while answering a valid request. */
export const INTERNAL_ERROR = -32_603;
/** Application: a name or arguments outside the static interface. */
export const TOOL_NOT_PERMITTED = -32_001;
/** Application: the daemon connection behind the bound target is down. */
export const BRIDGE_DOWN = -32_010;

// #endregion

const JSONRPC_VERSION = '2.0';
// https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#version-negotiation
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
// MCP version negotiation: echo the client's requested version only if this
// server implements it, else answer with one it does. Earlier revisions
// require JSON-RPC batching, which this server does not implement.
const SUPPORTED_PROTOCOL_VERSIONS = harden([DEFAULT_PROTOCOL_VERSION]);

// Tool names are flat, interface-native camelCase: no transport or category
// prefix, no `_` (so no `__` that would parse ambiguously against Claude
// Code's `mcp__<server>__<tool>` grammar), and short enough for any client.
const TOOL_NAME_RE = /^[a-z][A-Za-z0-9]{0,63}$/;

// Property names that must never be tool names, because a dispatcher keyed on
// them could resolve to inherited or meta behavior.
const RESERVED_PROPERTY_NAMES = harden([
  '__proto__',
  '__getMethodNames__',
  '__getInterfaceGuard__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  'then',
]);

// Every construction error this module mints, so recognition is by brand and
// never by an incidental `reason` property on some other error.
/** @type {WeakSet<Error>} */
const constructionErrors = new WeakSet();

/**
 * Make a hardened construction error. A consumer may mint its own
 * discriminants (for example a transport's startup failures) by widening
 * `R`; this module itself only produces `ConstructionReason`.
 *
 * @template {string} [R=ConstructionReason]
 * @param {R} reason
 * @param {string} message
 * @param {{ names?: string[], cause?: unknown }} [extra]
 * @returns {ConstructionError<R>}
 */
export const makeConstructionError = (reason, message, extra = {}) => {
  const { names, cause } = extra;
  // `sanitize: false` leaves the error extensible so the discriminants can be
  // added before it is hardened.
  const error = /** @type {ConstructionError<R>} */ (
    makeError(message, undefined, {
      sanitize: false,
      ...(cause === undefined ? {} : { cause: /** @type {Error} */ (cause) }),
    })
  );
  // Non-enumerable, like the `code` that `makeError` itself attaches, so the
  // discriminants never read as data fields of the error.
  Object.defineProperty(error, 'reason', { value: reason, enumerable: false });
  if (names !== undefined) {
    Object.defineProperty(error, 'names', {
      value: harden([...names]),
      enumerable: false,
    });
  }
  constructionErrors.add(error);
  return harden(error);
};
harden(makeConstructionError);

/**
 * @param {unknown} error
 * @returns {error is ConstructionError<string>}
 */
export const isConstructionError = error =>
  error instanceof Error && constructionErrors.has(error);
harden(isConstructionError);

/**
 * Validate a static tool declaration and project it to an MCP catalog. Throws
 * a discriminated construction error (`empty-interface`, `malformed-name`, or
 * `catalog-name-conflict`) on an invalid declaration. A caller that reserves
 * names for its own purposes passes them as `advisoryReservedNames`; a
 * collision with them is returned as a warning, never a throw.
 *
 * @template [T=unknown]
 * @param {ReadonlyArray<ToolDeclaration<T>>} declarations
 * @param {{ advisoryReservedNames?: ReadonlyArray<string> }} [options]
 * @returns {ToolCatalog<T>}
 */
export const makeToolCatalog = (
  declarations,
  { advisoryReservedNames = [] } = {},
) => {
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw makeConstructionError(
      'empty-interface',
      'The static tool declaration contains no tools',
    );
  }

  const malformed = [];
  for (const declaration of declarations) {
    const name = declaration && declaration.name;
    if (
      typeof name !== 'string' ||
      !TOOL_NAME_RE.test(name) ||
      name.includes('__') ||
      RESERVED_PROPERTY_NAMES.includes(name) ||
      typeof declaration.invoke !== 'function' ||
      typeof declaration.description !== 'string' ||
      declaration.inputSchema === null ||
      typeof declaration.inputSchema !== 'object'
    ) {
      malformed.push(String(name));
    }
  }
  if (malformed.length > 0) {
    throw makeConstructionError(
      'malformed-name',
      `The static tool declaration has malformed entries: ${malformed.join(', ')}`,
      { names: malformed },
    );
  }

  /** @type {Map<string, string>} */
  const folded = new Map();
  const conflicts = [];
  for (const { name } of declarations) {
    const key = name.toLowerCase();
    const prior = folded.get(key);
    if (prior !== undefined) {
      conflicts.push(prior, name);
    } else {
      folded.set(key, name);
    }
  }
  if (conflicts.length > 0) {
    throw makeConstructionError(
      'catalog-name-conflict',
      `The static tool declaration has duplicate or case-confusable names: ${conflicts.join(', ')}`,
      { names: conflicts },
    );
  }

  const byName = /** @type {Record<string, ToolDeclaration<T>>} */ (
    /** @type {unknown} */ ({ __proto__: null })
  );
  /** @type {McpTool[]} */
  const tools = [];
  for (const declaration of declarations) {
    byName[declaration.name] = declaration;
    tools.push(
      harden({
        name: declaration.name,
        description: declaration.description,
        inputSchema: declaration.inputSchema,
      }),
    );
  }
  const names = declarations.map(({ name }) => name);

  /** @type {CatalogWarning[]} */
  const warnings = [];
  const collisions = names.filter(name => advisoryReservedNames.includes(name));
  if (collisions.length > 0) {
    warnings.push({
      reason: 'reserved-name-collision',
      level: 'warning',
      names: collisions,
    });
  }

  return harden({ tools, names, byName, warnings });
};
harden(makeToolCatalog);

/**
 * Render the Claude Code `--allowedTools` entries for a catalog served under
 * the fixed server label.
 *
 * @param {{ names: ReadonlyArray<string> }} catalog
 * @param {string} [serverLabel]
 * @returns {string[]}
 */
export const renderAllowedTools = ({ names }, serverLabel = 'endo') =>
  harden(names.map(name => `mcp__${serverLabel}__${name}`));
harden(renderAllowedTools);

/**
 * Render a passable tool result as text for an MCP `content` block.
 * Strings pass through; everything else is JSON with bigints as decimal
 * strings and remotables/promises as opaque placeholders.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const renderToolResult = value => {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  const replacer = (_key, v) => {
    if (typeof v === 'bigint') {
      return `${v}`;
    }
    if (typeof v === 'object' && v !== null) {
      let style;
      try {
        style = passStyleOf(v);
      } catch {
        return v;
      }
      if (style === 'remotable') return '[remotable]';
      if (style === 'promise') return '[promise]';
      if (style === 'error') return { error: `${v.message}` };
      if (style === 'tagged') return `[tagged ${v[Symbol.toStringTag]}]`;
    }
    if (typeof v === 'symbol') {
      return String(v);
    }
    return v;
  };
  return JSON.stringify(value, replacer, 2) ?? '';
};
harden(renderToolResult);

/**
 * The argument names a declaration's JSON Schema declares. An argument outside
 * them is out of scope even when `argumentsShape` would tolerate it.
 *
 * @param {{ inputSchema: object }} declaration
 * @returns {Set<string>}
 */
const declaredArgumentNames = ({ inputSchema }) => {
  const { properties } = /** @type {{ properties?: unknown }} */ (inputSchema);
  return new Set(
    properties !== null && typeof properties === 'object'
      ? Object.keys(properties)
      : [],
  );
};

// MCP logging levels, least to most severe: the RFC 5424 syslog severities.
// https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging#log-levels
const LOG_LEVELS = harden([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
]);

/**
 * Build an MCP tool server bound to exactly one target. The catalog is fixed
 * at construction; `tools/call` rejects every name outside it before reaching
 * the target.
 *
 * @template [T=unknown]
 * @param {object} options
 * @param {ToolCatalog<T>} options.catalog - from `makeToolCatalog`.
 * @param {T} options.target - the one bound facet every call dispatches to.
 * @param {{ name: string, version: string }} options.serverInfo
 * @param {Promise<unknown>} [options.connectionClosed] - settles when the
 *   connection behind `target` is lost; afterwards every `tools/call` is a
 *   `bridge-down` error.
 * @param {(message: object) => void} [options.notify] - sends a JSON-RPC
 *   notification (used by the logging facet).
 * @param {string} [options.instructions]
 */
export const makeMcpToolServer = ({
  catalog,
  target,
  serverInfo,
  connectionClosed,
  notify = () => {},
  instructions,
}) => {
  /** @type {undefined | { detail: string }} */
  let bridgeDown;
  /**
   * The rejecters of the calls now in flight. Each call races its own
   * short-lived promise rather than one that lives as long as the connection:
   * on V8, every `Promise.race` against a long-lived pending promise leaves a
   * reaction on it that retains the settled result until the connection
   * closes (nodejs/node#17469).
   *
   * @type {Set<(reason: unknown) => void>}
   */
  const inFlightRejecters = new Set();
  /** @param {string} detail */
  const markBridgeDown = detail => {
    bridgeDown = { detail };
    for (const reject of inFlightRejecters) {
      reject(bridgeDown);
    }
    inFlightRejecters.clear();
  };
  if (connectionClosed !== undefined) {
    Promise.resolve(connectionClosed).then(
      value =>
        markBridgeDown(
          value === undefined
            ? 'connection closed'
            : `connection closed: ${String(value)}`,
        ),
      error =>
        markBridgeDown(
          `connection closed: ${(error && error.message) || String(error)}`,
        ),
    );
  }

  let logThreshold = LOG_LEVELS.indexOf('info');

  /**
   * The logging facet: forwards a diagnostic to the client as an MCP
   * `notifications/message` when at or above the client's requested level.
   *
   * @param {string} level
   * @param {unknown} data
   */
  const log = (level, data) => {
    const index = LOG_LEVELS.indexOf(level);
    if (index < 0 || index < logThreshold) {
      return;
    }
    notify(
      harden({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/message',
        params: { level, logger: serverInfo.name, data },
      }),
    );
  };

  /**
   * @param {string | number | null} id
   * @param {unknown} result
   * @returns {JsonRpcResponse}
   */
  const ok = (id, result) => harden({ jsonrpc: JSONRPC_VERSION, id, result });

  /**
   * @param {string | number | null} id
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   * @returns {JsonRpcResponse}
   */
  const fail = (id, code, message, data) =>
    harden({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    });

  /**
   * @param {string | number | null} id
   * @param {any} params
   */
  const callTool = async (id, params) => {
    if (params === null || typeof params !== 'object') {
      return fail(id, INVALID_PARAMS, 'tools/call requires params');
    }
    const { name, arguments: rawArguments = {} } = params;
    if (typeof name !== 'string' || !Object.hasOwn(catalog.byName, name)) {
      return fail(id, TOOL_NOT_PERMITTED, 'tool-not-permitted', {
        reason: 'name-scope',
        name: typeof name === 'string' ? name : undefined,
      });
    }
    const declaration = catalog.byName[name];
    const argumentNames = declaredArgumentNames(declaration);
    /** @type {any} */
    let toolArguments;
    try {
      toolArguments = harden(JSON.parse(JSON.stringify(rawArguments)));
    } catch {
      toolArguments = undefined;
    }
    if (
      toolArguments === null ||
      typeof toolArguments !== 'object' ||
      Array.isArray(toolArguments) ||
      !Object.keys(toolArguments).every(key => argumentNames.has(key)) ||
      !matches(toolArguments, declaration.argumentsShape)
    ) {
      return fail(id, TOOL_NOT_PERMITTED, 'tool-not-permitted', {
        reason: 'argument-scope',
        name,
      });
    }
    if (declaration.normalizeArguments !== undefined) {
      try {
        toolArguments = harden(
          declaration.normalizeArguments(
            /** @type {Record<string, any>} */ (toolArguments),
          ),
        );
      } catch {
        return fail(id, TOOL_NOT_PERMITTED, 'tool-not-permitted', {
          reason: 'argument-scope',
          name,
        });
      }
    }
    if (bridgeDown !== undefined) {
      return fail(id, BRIDGE_DOWN, 'bridge-down', bridgeDown);
    }
    /** @type {(reason: unknown) => void} */
    let rejectOnBridgeDown = () => {};
    /** @type {Promise<never>} */
    const bridgeDownForCall = new Promise((_, reject) => {
      rejectOnBridgeDown = reject;
    });
    inFlightRejecters.add(rejectOnBridgeDown);
    let value;
    try {
      value = await Promise.race([
        bridgeDownForCall,
        (async () => declaration.invoke(target, toolArguments))(),
      ]);
    } catch (error) {
      if (bridgeDown !== undefined) {
        return fail(id, BRIDGE_DOWN, 'bridge-down', bridgeDown);
      }
      const message =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      log('warning', { tool: name, error: message });
      return ok(id, {
        isError: true,
        content: [{ type: 'text', text: message }],
      });
    } finally {
      inFlightRejecters.delete(rejectOnBridgeDown);
    }
    return ok(id, {
      content: [{ type: 'text', text: renderToolResult(value) }],
    });
  };

  /**
   * Answer one decoded JSON-RPC message. Returns `undefined` for a
   * notification (which takes no reply).
   *
   * @param {unknown} message
   * @returns {Promise<JsonRpcResponse | undefined>}
   */
  const handleMessage = async message => {
    if (
      message === null ||
      typeof message !== 'object' ||
      Array.isArray(message)
    ) {
      return fail(null, INVALID_REQUEST, 'Invalid Request');
    }
    const { jsonrpc, method, params } = /** @type {any} */ (message);
    const hasId = Object.hasOwn(message, 'id');
    const rawId = /** @type {any} */ (message).id;
    // MCP narrows JSON-RPC's id: a string or an integer, never `null`
    // (MCP 2025-06-18 basic § Requests).
    const idValid =
      !hasId || typeof rawId === 'string' || Number.isInteger(rawId);
    const id = hasId && idValid ? rawId : null;
    if (
      method === undefined &&
      (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    ) {
      // A response is not a request (JSON-RPC 2.0 §5): drop it unanswered.
      return undefined;
    }
    if (jsonrpc !== JSONRPC_VERSION || typeof method !== 'string' || !idValid) {
      // Only a valid Request object without an id is a Notification
      // (JSON-RPC 2.0 §4.1); an invalid one is answered with `id: null`, as in
      // the specification's §7 example `{"jsonrpc": "2.0", "method": 1}`.
      return fail(id, INVALID_REQUEST, 'Invalid Request');
    }
    if (!hasId) {
      // A notification takes no reply (JSON-RPC 2.0 §4.1).
      return undefined;
    }
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        return ok(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo,
          ...(instructions === undefined ? {} : { instructions }),
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: catalog.tools });
      case 'tools/call':
        return callTool(id, params);
      case 'logging/setLevel': {
        const level = params && params.level;
        const index =
          typeof level === 'string' ? LOG_LEVELS.indexOf(level) : -1;
        if (index < 0) {
          return fail(
            id,
            INVALID_PARAMS,
            typeof level === 'string'
              ? `Unknown log level: ${level}`
              : 'logging/setLevel requires a string level',
          );
        }
        logThreshold = index;
        return ok(id, {});
      }
      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  /**
   * Answer one framed line. Returns the serialized reply, or `undefined` when
   * no reply is owed. Never rejects: a failure while answering a request is
   * an `Internal error` reply for its id, so no request goes unanswered.
   *
   * @param {string} line
   * @returns {Promise<string | undefined>}
   */
  const handleLine = async line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return JSON.stringify(fail(null, PARSE_ERROR, 'Parse error'));
    }
    try {
      const reply = await handleMessage(message);
      return reply === undefined ? undefined : JSON.stringify(reply);
    } catch (error) {
      const rawId =
        message !== null && typeof message === 'object'
          ? /** @type {any} */ (message).id
          : undefined;
      if (rawId === undefined) {
        return undefined;
      }
      return JSON.stringify(
        fail(
          typeof rawId === 'string' || Number.isInteger(rawId) ? rawId : null,
          INTERNAL_ERROR,
          'Internal error',
          { detail: /** @type {Error} */ (error)?.message ?? String(error) },
        ),
      );
    }
  };

  return harden({ handleMessage, handleLine, log });
};
harden(makeMcpToolServer);

/**
 * Convenience: an `invoke` that forwards to a same-named method on the target
 * with positional arguments picked from the arguments record.
 *
 * @param {string} method
 * @param {(toolArguments: Record<string, any>) => unknown[]} [pick]
 * @returns {(target: unknown, toolArguments: Record<string, any>) => unknown}
 */
export const forwardTo =
  (method, pick = () => []) =>
  (target, toolArguments) =>
    E(target)[method](...pick(toolArguments));
harden(forwardTo);
