// @ts-check
/**
 * Granted tools (M5 W5.6; `designs/m5-interfaces.md` 2.5, R3-6, P-65).
 *
 * The `grants` runtime part (`grantsPart`, registered in `runtime-parts.js`)
 * keeps one session's granted tools in its heap (at most `maxGrantedTools`)
 * and answers:
 *
 *   { facet, grant(tool, source, label?), schemaRead(grant),
 *     entriesFor(ports, builtIns?), size() }
 *
 * - `facet` is the `SessionGrants` exo `Session.grants()` hands out;
 *   `grantTool(tool)` keeps a grant (`pending`, source `operator`) and, in
 *   the same crank, asks the session's exec vat for the tool's schema
 *   (`ExecScope.inspect` op `toolSchema`, D-M5-2: the session never makes an
 *   answered call to the tool). The answer makes the grant `offered` (a
 *   `ToolDescription` the exec program checked and cut) or
 *   `refused-schema` with the reason.
 * - `grant(tool, source, label?)` is the same for another part (W5.7
 *   `adoptTool`, source `adopted`, `label` its `toolName`, shown as
 *   `ToolGrantInfo.label`: XC, 2.6); `schemaRead(grant)` answers the grant's
 *   `ToolGrantInfo` once its schema read has settled (at once when it has).
 * - `entriesFor(ports, builtIns)` is what `grantedToolSource` answers at
 *   every round (S1): the dynamic tool-table entries of the described
 *   grants, after this round's states are set: a name in `builtIns` (the
 *   static table and the round's adapter tools) is `refused-builtin`; a name
 *   two described grants claim refuses both (`refused-duplicate`); the
 *   others are `offered` oldest first while their descriptions' UTF-8 bytes
 *   fit `roundGrantedToolBytes`, and from the first that does not fit on,
 *   `refused-budget` (newest first). `toolSetFor` applies the built-in and
 *   duplicate rules again over every dynamic source and reports refusals
 *   through each entry's `refused(state, reason)`, so a clash with another
 *   source's entry is seen too. Budget-refused entries are not returned.
 *   A pending grant whose read was issued on ports of an earlier adapter
 *   incarnation (or on none) is read again with these ports.
 *
 * A granted tool's call (`site: 'guest'`) is an inspector `toolExecute`
 * with the model's argument text (inline or staged), the exec deadline
 * armed (the entry's `deadline` hook is `inspectDeadline`); the exec
 * program parses, measures, calls `E(tool).execute(args)` and renders the
 * answer (a string as is, anything else as JSON; cut and staged).
 *
 * The session keeps the last ports a round (or the open at creation) gave
 * the source, so a grant made outside a turn has `BlobWriters` for its
 * inspector request (the `InspectRequest` guard requires them).
 *
 * Guest rules.
 */
import { interfaces, textOf, texts } from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { utf8Bytes, messageOf } from '../../lib/bounded.js';
import { isStaged } from '../staging.js';
import { inspectDeadline, inspectFor } from './inspect-client.js';

/** @import { ToolTableEntry } from '../tool-table.js' */

// The exo methods are typed loosely; the interface guards check the values.
const { makeExo } = /** @type {any} */ (globalThis);

/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/** The prefix of every `refused-schema` reason. */
const SCHEMA_PREFIX = textOf.toolSchemaInvalid('');

/**
 * The `refused-schema` reason of a failed schema read: the inspector's text
 * when it is already the schema text, else that text wrapped in it.
 * @param {unknown} text
 */
const schemaReason = text => {
  if (typeof text !== 'string' || isStaged(text)) {
    return textOf.toolSchemaInvalid('the schema could not be read');
  }
  const reason = text.startsWith(SCHEMA_PREFIX)
    ? text
    : textOf.toolSchemaInvalid(text);
  return reason.slice(0, limits.reasonUnits);
};

/**
 * @typedef {object} Grant one granted tool (session heap)
 * @property {any} tool the granted object (never called here)
 * @property {'operator' | 'adopted'} source
 * @property {string} [label] the display label (`adoptTool`'s `toolName`)
 * @property {string} state one of `grantStates`
 * @property {string} [reason]
 * @property {{ name: string, description: string, parameters: string }} [description]
 * @property {number} bytes UTF-8 bytes of the description's three texts
 * @property {ToolTableEntry} [entry]
 * @property {number} [readSince] `since` of the ports the last read used
 * @property {((info: any) => void)[]} waiters `schemaRead` callers
 * @property {any} handle the `ToolGrant` exo
 */

/**
 * @typedef {object} GrantsOptions for tests; the session passes none
 * @property {typeof inspectFor} [inspectFor]
 * @property {typeof inspectDeadline} [inspectDeadline]
 */

/**
 * The `grants` part of one session.
 * @param {any} runtime the session's runtime (`runtime-parts.js`)
 * @param {GrantsOptions} [options]
 */
export const makeGrants = (
  runtime,
  {
    inspectFor: inspectWith = inspectFor,
    inspectDeadline: onDeadline = inspectDeadline,
  } = {},
) => {
  /**
   * Kept grants in grant order (withdrawn ones leave).
   * @type {Map<any, Grant>}
   */
  const kept = new Map();
  /** Every handle's grant, withdrawn ones too (the handle keeps answering). */
  /** @type {WeakMap<any, Grant>} */
  const byHandle = new WeakMap();
  /** The latest ports a round or the open gave the source. */
  /** @type {any} */
  let latestPorts;
  /** Their `since`. */
  let latestSince = -1;
  /** The latest built-in name set (for states set between rounds). */
  /** @type {Set<string> | undefined} */
  let latestBuiltIns;
  /** The inspector context of calls outside a turn (no deadline). */
  const grantContext = harden({ services: runtime.services, runtime });

  /** @param {Grant} grant */
  const infoOf = grant => {
    /** @type {Record<string, any>} */
    const info = {
      grant: grant.handle,
      state: grant.state,
      source: grant.source,
    };
    if (grant.description !== undefined) info.name = grant.description.name;
    if (grant.reason !== undefined) info.reason = grant.reason;
    if (grant.label !== undefined) info.label = grant.label;
    return harden(info);
  };

  /** @param {Grant} grant */
  const wake = grant => {
    if (grant.waiters.length === 0) return;
    const info = infoOf(grant);
    for (const resolve of grant.waiters.splice(0)) resolve(info);
  };

  /**
   * @param {Grant} grant
   * @param {string} state
   * @param {string} [reason]
   */
  const setState = (grant, state, reason = undefined) => {
    if (grant.state === 'withdrawn') return;
    grant.state = state;
    grant.reason = reason;
  };

  /**
   * Set this round's states of the described grants (module comment) and
   * answer the entries `toolSetFor` sees.
   * @param {Set<string>} builtIns
   * @returns {ToolTableEntry[]}
   */
  const classify = builtIns => {
    /** @type {Map<string, number>} */
    const claims = new Map();
    for (const grant of kept.values()) {
      if (grant.description !== undefined) {
        const { name } = grant.description;
        claims.set(name, (claims.get(name) ?? 0) + 1);
      }
    }
    /** @type {ToolTableEntry[]} */
    const entries = [];
    let bytes = 0;
    let over = false;
    for (const grant of kept.values()) {
      const { description, entry } = grant;
      if (description !== undefined && entry !== undefined) {
        const { name } = description;
        if (builtIns.has(name)) {
          setState(grant, 'refused-builtin', textOf.toolNameBuiltIn(name));
          entries.push(entry);
        } else if (/** @type {number} */ (claims.get(name)) > 1) {
          setState(grant, 'refused-duplicate', textOf.toolNameDuplicate(name));
          entries.push(entry);
        } else if (over || bytes + grant.bytes > limits.roundGrantedToolBytes) {
          over = true;
          setState(grant, 'refused-budget', textOf.toolOverBudget(name));
        } else {
          bytes += grant.bytes;
          setState(grant, 'offered');
          entries.push(entry);
        }
      }
    }
    return entries;
  };

  /**
   * The dynamic tool-table entry of a described grant.
   * @param {Grant} grant
   * @param {{ name: string, description: string, parameters: string }} description
   * @returns {ToolTableEntry}
   */
  const entryOf = (grant, description) =>
    harden({
      name: description.name,
      site: 'guest',
      describe: () => description,
      available: () => true,
      execute: ({ opId, args }, ports, context) => {
        /** @type {Record<string, any>} */
        const request = {
          op: 'toolExecute',
          target: grant.tool,
          writers: ports?.writers,
          args,
          opId,
        };
        if (ports?.content !== undefined) request.content = ports.content;
        return inspectWith(context)(harden(request));
      },
      deadline: (request, context) => {
        onDeadline(request, context);
      },
      refused: (state, reason) => setState(grant, state, reason),
    });

  /**
   * @param {Grant} grant
   * @param {any} outcome
   */
  const onSchema = (grant, outcome) => {
    if (grant.state !== 'pending') return;
    if (outcome?.status === 'ok' && outcome.description !== undefined) {
      const { description } = outcome;
      grant.description = description;
      grant.bytes =
        utf8Bytes(description.name) +
        utf8Bytes(description.description) +
        utf8Bytes(description.parameters);
      grant.entry = entryOf(grant, description);
      setState(grant, 'offered');
      // States between rounds follow the last round's rules.
      if (latestBuiltIns !== undefined) classify(latestBuiltIns);
    } else {
      setState(grant, 'refused-schema', schemaReason(outcome?.text));
    }
    wake(grant);
  };

  /**
   * Ask the exec vat for the grant's schema on these ports.
   * @param {Grant} grant
   * @param {any} ports
   */
  const read = (grant, ports) => {
    grant.readSince = ports.since;
    /** @type {Record<string, any>} */
    const request = {
      op: 'toolSchema',
      target: grant.tool,
      writers: ports.writers,
    };
    let answer;
    try {
      answer = Promise.resolve(inspectWith(grantContext)(harden(request)));
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      outcome => onSchema(grant, outcome),
      error => onSchema(grant, failed(messageOf(error))),
    );
  };

  /**
   * @param {any} tool
   * @param {'operator' | 'adopted'} source
   * @param {string} [label] the display label (a valid label; the caller
   *   checks it)
   */
  const grant = (tool, source, label = undefined) => {
    if (kept.size >= limits.maxGrantedTools) {
      throw Error(texts.grantsFull);
    }
    /** @type {Grant} */
    const record = {
      tool,
      source,
      label,
      state: 'pending',
      bytes: 0,
      waiters: [],
      handle: undefined,
    };
    const handle = makeExo('ToolGrant', interfaces.ToolGrant, {
      describe() {
        return infoOf(record);
      },
      withdraw() {
        if (record.state === 'withdrawn') return;
        record.state = 'withdrawn';
        record.reason = texts.grantWithdrawn;
        kept.delete(handle);
        wake(record);
      },
    });
    record.handle = handle;
    kept.set(handle, record);
    byHandle.set(handle, record);
    if (latestPorts !== undefined) read(record, latestPorts);
    return handle;
  };

  const facet = makeExo('SessionGrants', interfaces.SessionGrants, {
    /** @param {any} tool */
    grantTool(tool) {
      return grant(tool, 'operator');
    },
    list() {
      return harden([...kept.values()].map(infoOf));
    },
  });

  /**
   * The grant's info once its schema read settled.
   * @param {any} handle a `ToolGrant` this part made
   * @returns {Promise<any>}
   */
  const schemaRead = handle => {
    const record = byHandle.get(handle);
    if (record === undefined) {
      return Promise.reject(Error('not a grant of this session'));
    }
    if (record.state !== 'pending') return Promise.resolve(infoOf(record));
    return new Promise(resolve => {
      record.waiters.push(resolve);
    });
  };

  /**
   * The round's entries (`grantedToolSource`).
   * @param {any} ports
   * @param {Set<string>} [builtIns] default: the ports' adapter tool names
   */
  const entriesFor = (ports, builtIns = undefined) => {
    const names =
      builtIns ??
      new Set((ports?.tools ?? []).map((/** @type {any} */ t) => t.name));
    if (ports !== undefined) {
      const since = /** @type {number} */ (ports.since);
      if (since >= latestSince) {
        latestPorts = ports;
        latestSince = since;
        latestBuiltIns = names;
      }
      for (const record of kept.values()) {
        if (
          record.state === 'pending' &&
          (record.readSince === undefined || record.readSince < since)
        ) {
          read(record, ports);
        }
      }
    }
    return classify(names);
  };

  return harden({
    facet,
    grant,
    schemaRead,
    entriesFor,
    size: () => kept.size,
  });
};
harden(makeGrants);

/** The `runtime-parts.js` entry. */
export const grantsPart = harden({
  name: /** @type {const} */ ('grants'),
  /** @param {any} runtime */
  make: runtime => makeGrants(runtime),
});

/**
 * The `toolSources` entry (S1): the granted tools of the round. `builtIns`
 * is the round's built-in name set (`tool-table.js` passes it).
 * @param {any} ports
 * @param {any} _services
 * @param {any} runtime
 * @param {Set<string>} [builtIns]
 * @returns {readonly ToolTableEntry[]}
 */
export const grantedToolSource = (ports, _services, runtime, builtIns) => {
  const grants = runtime?.grants;
  if (grants?.entriesFor === undefined) return harden([]);
  return harden(grants.entriesFor(ports, builtIns));
};
harden(grantedToolSource);
