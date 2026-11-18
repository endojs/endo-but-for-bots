// @ts-check
/**
 * The fake subscription server (M4 W4.3; designs/m4-interfaces.md 5.3, 12;
 * D-M2-4).
 *
 * An HTTP server on 127.0.0.1 and a free port that answers the two
 * subscription providers' requests from a plan the test sets, as M2's
 * `fake-provider-server.mjs` does for the API providers (same plan entries,
 * M2 8.3: status and headers, SSE fixture or inline events, delays, slow
 * first byte, disconnect, hang, repeat). No real provider and no real
 * credential is involved, and the server never records a header value:
 * `requests()` reports the names of the headers a request carried (so a
 * test can check R4-30's client headers are present) and, when the test
 * gives a `credentialTag`, the label it maps the bearer token to.
 *
 *   const server = await startFakeSubscriptionServer();
 *   server.setPlan([{ sse: 'claude-text.sse' }]);
 *   // a pool spec's baseUrl: server.url (both kinds)
 *   server.requests(); // [{ method, path, query, json, headerNames, ... }]
 *   await server.close();
 *
 * Routes (the providers' own paths under one origin):
 *
 * - Claude: `POST /v1/messages` (Messages SSE), `GET /v1/models` (model
 *   list), `GET /api/oauth/usage` (usage read);
 * - Codex: `POST /backend-api/codex/responses` (Responses SSE),
 *   `GET /backend-api/codex/models` (model list),
 *   `GET /backend-api/wham/usage` (usage read).
 *
 * A request takes the first plan entry whose `match` fits it (an entry
 * without `match` fits any POST; a GET needs a `match`); else the route's
 * entry in `defaults` (option, reused for every request); else it is
 * answered 500 and recorded `unplanned`. Fixture files are read from
 * `test/fixtures/sse/subscriptions/` (option `fixtures`).
 *
 * Builders for inline events: `claudeEvents` (M2's `anthropicEvents`) and
 * `codexEvents` (Responses streaming events: lifecycle, text deltas, output
 * items for messages, function calls and encrypted reasoning, completion or
 * a failure event); `exhaustedHeaders` / `readingHeaders` give the
 * providers' rate-limit headers.
 *
 * Node only (tests and perf); not shipped to a vat.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  anthropicEvents,
  BODY_MARKER,
  sseEventText,
  sseText,
  splitSseFixture,
} from './fake-provider-server.mjs';

export { BODY_MARKER, sseText };
/** Claude Messages events (M2's builder; the wire format is the API's). */
export const claudeEvents = anthropicEvents;

/** Where the subscription fixtures live. */
export const subscriptionFixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'sse',
  'subscriptions',
);

/** @typedef {import('./fake-provider-server.mjs').PlanEntry} PlanEntry */
/** @typedef {import('./fake-provider-server.mjs').PlanEvent} PlanEvent */

/**
 * @typedef {object} SubscriptionRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} query the query parameters (no
 *   credential is ever sent in one)
 * @property {any} json the parsed body, or undefined
 * @property {number} bodyBytes
 * @property {string[]} headerNames sorted, lower case; never a value
 * @property {boolean} authorization a bearer authorization was present
 * @property {string} [credential] the `credentialTag` label of the token
 * @property {boolean} closed the client closed before the response ended
 * @property {boolean} completed
 * @property {boolean} unplanned
 * @property {number} events SSE events written
 * @property {number} receivedAt `performance.now()` when the body was read
 */

/** @type {Record<string, 'claude' | 'codex'>} */
const ROUTES = {
  'POST /v1/messages': 'claude',
  'GET /v1/models': 'claude',
  'GET /api/oauth/usage': 'claude',
  'POST /backend-api/codex/responses': 'codex',
  'GET /backend-api/codex/models': 'codex',
  'GET /backend-api/wham/usage': 'codex',
};

/**
 * Responses streaming events (the shapes lal `subscription-responses.js`
 * reads): `response.created`, `response.in_progress`, per output item
 * `response.output_item.added` and `.done` (reasoning items with
 * `encrypted_content`, function calls with their arguments, the message
 * with its text), text as `response.output_text.delta`, then
 * `response.completed` with `usage` and an empty `output` (as subscription
 * streams acknowledge), or a failure event.
 *
 * @param {object} [options]
 * @param {string[]} [options.deltas] text pieces of one message
 * @param {Array<{ id?: string, name: string, args: string }>} [options.toolCalls]
 * @param {Array<{ id?: string, encrypted: string }>} [options.reasoning]
 *   reasoning items before the message
 * @param {any} [options.usage] the completion's usage
 * @param {string} [options.model]
 * @param {boolean} [options.completedOutput] repeat the items in the
 *   completion's `output` (the API's non-subscription form)
 * @param {{ type?: 'error' | 'response.failed' | 'response.incomplete', code?: string | number, errorType?: string, param?: string, reason?: string, message?: string }} [options.failure]
 *   a failure event instead of the completion, after `failureAfter` text
 *   deltas (default 0)
 * @param {number} [options.failureAfter]
 * @param {boolean} [options.complete] send the completion (default true)
 * @returns {PlanEvent[]}
 */
export const codexEvents = ({
  deltas = [],
  toolCalls = [],
  reasoning = [],
  usage = {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 19,
  },
  model = 'gpt-fake-1',
  completedOutput = false,
  failure,
  failureAfter = 0,
  complete = true,
} = {}) => {
  /** @type {PlanEvent[]} */
  const events = [];
  /**
   * @param {string} type
   * @param {Record<string, unknown>} fields
   */
  const event = (type, fields) => ({ data: { type, ...fields } });
  const response = (/** @type {string} */ status, /** @type {any} */ more) => ({
    id: 'resp_fake_1',
    object: 'response',
    model,
    status,
    output: [],
    ...more,
  });
  events.push(
    event('response.created', { response: response('in_progress', {}) }),
  );
  events.push(
    event('response.in_progress', { response: response('in_progress', {}) }),
  );
  /** @type {any[]} */
  const items = [];
  let index = 0;
  const failureEvent = () => {
    const f = failure ?? {};
    const type = f.type ?? 'response.failed';
    const error = {
      ...(f.code === undefined ? {} : { code: f.code }),
      ...(f.errorType === undefined ? {} : { type: f.errorType }),
      ...(f.param === undefined ? {} : { param: f.param }),
      message: f.message ?? `${BODY_MARKER} failure`,
    };
    if (type === 'error') return event('error', { ...error, error });
    if (type === 'response.incomplete')
      return event('response.incomplete', {
        response: response('incomplete', {
          incomplete_details: { reason: f.reason ?? 'max_output_tokens' },
        }),
      });
    return event('response.failed', {
      response: response('failed', { error }),
    });
  };
  for (const block of reasoning) {
    const item = {
      type: 'reasoning',
      id: block.id ?? `rs_fake_${index}`,
      summary: [],
      encrypted_content: block.encrypted,
    };
    events.push(
      event('response.output_item.added', {
        output_index: index,
        item: { type: 'reasoning', id: item.id, summary: [] },
      }),
    );
    events.push(
      event('response.output_item.done', { output_index: index, item }),
    );
    items.push(item);
    index += 1;
  }
  if (failure !== undefined && failureAfter === 0 && deltas.length === 0) {
    events.push(failureEvent());
    return events;
  }
  if (deltas.length > 0) {
    const id = `msg_fake_${index}`;
    events.push(
      event('response.output_item.added', {
        output_index: index,
        item: { type: 'message', id, role: 'assistant', content: [] },
      }),
    );
    for (let i = 0; i < deltas.length; i += 1) {
      if (failure !== undefined && i === failureAfter) {
        events.push(failureEvent());
        return events;
      }
      events.push(
        event('response.output_text.delta', {
          output_index: index,
          content_index: 0,
          item_id: id,
          delta: deltas[i],
        }),
      );
    }
    if (failure !== undefined) {
      events.push(failureEvent());
      return events;
    }
    const item = {
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: deltas.join(''), annotations: [] }],
    };
    events.push(
      event('response.output_item.done', { output_index: index, item }),
    );
    items.push(item);
    index += 1;
  }
  for (const call of toolCalls) {
    const item = {
      type: 'function_call',
      id: `fc_fake_${index}`,
      call_id: call.id ?? `call_fake_${index}`,
      name: call.name,
      arguments: call.args,
      status: 'completed',
    };
    events.push(
      event('response.output_item.added', {
        output_index: index,
        item: { ...item, arguments: '' },
      }),
    );
    events.push(
      event('response.function_call_arguments.delta', {
        output_index: index,
        item_id: item.id,
        delta: call.args,
      }),
    );
    events.push(
      event('response.output_item.done', { output_index: index, item }),
    );
    items.push(item);
    index += 1;
  }
  if (failure !== undefined) {
    events.push(failureEvent());
    return events;
  }
  if (complete) {
    events.push(
      event('response.completed', {
        response: response('completed', {
          output: completedOutput ? items : [],
          ...(usage === null ? {} : { usage }),
        }),
      }),
    );
  }
  return events;
};

/**
 * Rate-limit headers of a reading (the providers' names; W4.2's parser).
 * @param {'claude' | 'codex'} provider
 * @param {object} reading
 * @param {number} [reading.primaryPercent] 0..100
 * @param {number} [reading.secondaryPercent]
 * @param {number} [reading.primaryResetSec] epoch seconds
 * @param {number} [reading.secondaryResetSec]
 * @param {boolean} [reading.reached] the limit-reached flag
 * @returns {Record<string, string>}
 */
export const readingHeaders = (
  provider,
  {
    primaryPercent,
    secondaryPercent,
    primaryResetSec,
    secondaryResetSec,
    reached,
  },
) => {
  /** @type {Record<string, string>} */
  const headers = {};
  if (provider === 'codex') {
    if (primaryPercent !== undefined) {
      headers['x-codex-primary-used-percent'] = `${primaryPercent}`;
      headers['x-codex-primary-window-minutes'] = '300';
      if (primaryResetSec !== undefined)
        headers['x-codex-primary-reset-at'] = `${primaryResetSec}`;
    }
    if (secondaryPercent !== undefined) {
      headers['x-codex-secondary-used-percent'] = `${secondaryPercent}`;
      headers['x-codex-secondary-window-minutes'] = '10080';
      if (secondaryResetSec !== undefined)
        headers['x-codex-secondary-reset-at'] = `${secondaryResetSec}`;
    }
    if (reached)
      headers['x-codex-rate-limit-reached-type'] = 'rate_limit_reached';
    return headers;
  }
  if (primaryPercent !== undefined) {
    headers['anthropic-ratelimit-unified-5h-utilization'] = `${
      primaryPercent / 100
    }`;
    if (primaryResetSec !== undefined)
      headers['anthropic-ratelimit-unified-5h-reset'] = `${primaryResetSec}`;
  }
  if (secondaryPercent !== undefined) {
    headers['anthropic-ratelimit-unified-7d-utilization'] = `${
      secondaryPercent / 100
    }`;
    if (secondaryResetSec !== undefined)
      headers['anthropic-ratelimit-unified-7d-reset'] = `${secondaryResetSec}`;
  }
  headers['anthropic-ratelimit-unified-status'] = reached
    ? 'rejected'
    : 'allowed';
  return headers;
};

/**
 * A 429 plan entry whose headers say the subscription is used up until
 * `resetSec` (epoch seconds; the long window full).
 * @param {'claude' | 'codex'} provider
 * @param {number} resetSec
 * @returns {PlanEntry}
 */
export const exhaustedEntry = (provider, resetSec) => ({
  status: 429,
  headers: readingHeaders(provider, {
    primaryPercent: 40,
    secondaryPercent: 100,
    primaryResetSec: resetSec - 3600,
    secondaryResetSec: resetSec,
    reached: true,
  }),
});

/**
 * @param {object} [options]
 * @param {string} [options.fixtures] the fixture directory
 * @param {PlanEntry[]} [options.plan]
 * @param {Record<string, PlanEntry>} [options.defaults] per route
 *   (`'GET /v1/models'`), used when no plan entry fits
 * @param {(value: string) => string | undefined} [options.credentialTag]
 *   maps the bearer token a request carried to a label the test chose,
 *   recorded as `credential`; the token itself is never recorded
 * @param {(entry: { request: number, event: number, at: number }) => void} [options.trace]
 */
export const startFakeSubscriptionServer = async ({
  fixtures = subscriptionFixturesDir,
  plan: initialPlan = [],
  defaults = {},
  credentialTag,
  trace,
} = {}) => {
  /** @type {PlanEntry[]} */
  let plan = [...initialPlan];
  /** @type {Map<PlanEntry, number>} */
  const left = new Map();
  /** @type {SubscriptionRequest[]} */
  const recorded = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  /** @param {string} name */
  const fixture = name => {
    if (name.includes('/') || name.includes('\\') || name.startsWith('.'))
      throw Error(`fixture name must be a bare file name: ${name}`);
    return readFileSync(join(fixtures, name), 'utf8');
  };

  /**
   * @param {string} method
   * @param {string} path
   */
  const take = (method, path) => {
    const index = plan.findIndex(entry =>
      entry.match === undefined
        ? method === 'POST'
        : (entry.match.method ?? 'POST') === method &&
          (entry.match.path === undefined || entry.match.path === path),
    );
    if (index < 0) return defaults[`${method} ${path}`];
    const entry = plan[index];
    const remaining = (left.get(entry) ?? entry.repeat ?? 1) - 1;
    if (remaining <= 0) {
      plan.splice(index, 1);
      left.delete(entry);
    } else left.set(entry, remaining);
    return entry;
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handle = async (req, res) => {
    /** @type {Buffer[]} */
    const parts = [];
    for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts);
    const target = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = target.pathname;
    const method = req.method ?? 'GET';
    let json;
    try {
      json = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      json = undefined;
    }
    const bearer = String(req.headers.authorization ?? '');
    /** @type {SubscriptionRequest} */
    const record = {
      method,
      path,
      query: Object.fromEntries(target.searchParams),
      json,
      bodyBytes: raw.length,
      headerNames: Object.keys(req.headers)
        .map(name => name.toLowerCase())
        .sort(),
      authorization: /^Bearer \S+$/.test(bearer),
      ...(credentialTag === undefined
        ? {}
        : { credential: credentialTag(bearer.replace(/^Bearer /, '')) }),
      closed: false,
      completed: false,
      unplanned: false,
      events: 0,
      receivedAt: performance.now(),
    };
    const requestIndex = recorded.length;
    recorded.push(record);
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        gone = true;
        record.closed = true;
      }
    });
    const routed = ROUTES[`${method} ${path}`] !== undefined;
    const entry = routed ? take(method, path) : undefined;
    if (entry === undefined) {
      record.unplanned = true;
      res.writeHead(routed ? 500 : 404, {
        'content-type': 'application/json',
      });
      res.end(
        JSON.stringify({ error: { message: `${BODY_MARKER} no plan entry` } }),
      );
      record.completed = true;
      return;
    }
    if (entry.firstByteDelayMs) await sleep(entry.firstByteDelayMs);
    if (gone) return;
    if (entry.hang) return;
    const status = entry.status ?? 200;
    /** @type {{ text: string, delayMs?: number }[] | undefined} */
    let events;
    if (entry.sse !== undefined) events = splitSseFixture(fixture(entry.sse));
    else if (entry.events !== undefined)
      events = entry.events.map(event => ({
        text: sseEventText(event),
        ...(typeof event === 'object' && event.delayMs !== undefined
          ? { delayMs: event.delayMs }
          : {}),
      }));
    if (events === undefined) {
      /** @type {string} */
      let body;
      if (entry.file !== undefined) body = fixture(entry.file);
      else if (typeof entry.body === 'string') body = entry.body;
      else if (entry.body !== undefined) body = JSON.stringify(entry.body);
      else if (status >= 400)
        body = JSON.stringify({
          error: { message: `${BODY_MARKER} status ${status}`, code: status },
        });
      else body = '{}';
      res.writeHead(status, {
        'content-type': 'application/json',
        ...entry.headers,
      });
      if (entry.disconnectAfter !== undefined) {
        res.flushHeaders();
        res.socket?.destroy();
        return;
      }
      res.end(body);
      record.completed = true;
      return;
    }
    res.writeHead(status, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...entry.headers,
    });
    res.flushHeaders();
    for (let i = 0; i < events.length; i += 1) {
      if (entry.disconnectAfter !== undefined && i >= entry.disconnectAfter) {
        res.socket?.destroy();
        return;
      }
      const wait = events[i].delayMs ?? (i === 0 ? 0 : (entry.delayMs ?? 0));
      // eslint-disable-next-line no-await-in-loop
      if (wait > 0) await sleep(wait);
      if (gone) return;
      /** @type {() => void} */
      let written = () => {};
      const handed = new Promise(resolve => {
        written = () => resolve(undefined);
      });
      const flushed = res.write(events[i].text, () => written());
      record.events += 1;
      trace?.({ request: requestIndex, event: i, at: performance.now() });
      if (entry.disconnectAfter !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await handed;
      } else if (!flushed) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve(undefined);
          };
          res.once('drain', done);
          res.once('close', done);
        });
        if (gone) return;
      }
    }
    if (entry.disconnectAfter !== undefined) {
      res.socket?.destroy();
      return;
    }
    res.end();
    record.completed = true;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.destroy();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  );
  const url = `http://127.0.0.1:${address.port}`;
  return {
    /** The base URL of a pool spec (`baseUrl`, `usageUrl`), both kinds. */
    url,
    /** @param {PlanEntry[]} next replaces the plan */
    setPlan: next => {
      plan = [...next];
      left.clear();
    },
    /** @param {PlanEntry[]} entries appended to the plan */
    push: (...entries) => {
      plan.push(...entries);
    },
    /** Plan entries not yet used up. */
    pending: () => plan.length,
    /** @returns {SubscriptionRequest[]} */
    requests: () =>
      recorded.map(entry => ({ ...entry, headerNames: [...entry.headerNames] })),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  };
};

/** @typedef {Awaited<ReturnType<typeof startFakeSubscriptionServer>>} FakeSubscriptionServer */
