// @ts-check
/**
 * The fake provider server (M2 W2.1a; designs/m2-interfaces.md 8.3, D-M2-4).
 *
 * An HTTP server on 127.0.0.1 and a free port, never another address, that
 * answers provider requests from a plan the test sets. No real provider and
 * no real credential is involved: tests send short placeholder keys, and the
 * server records only whether an authorization header was present, never
 * its value.
 *
 *   const server = await startFakeProviderServer();
 *   server.setPlan([{ sse: 'openrouter-text.sse', delayMs: 5 }]);
 *   // OpenRouter base URL: `${server.url}/api/v1`; Anthropic: server.url
 *   ...
 *   server.requests(); // [{ method, path, json, authorization, closed, ... }]
 *   await server.close();
 *
 * Routes: `POST /api/v1/chat/completions` and `GET /api/v1/models`
 * (OpenRouter), `POST /v1/messages` and `GET /v1/models` (Anthropic). Every
 * request takes the first plan entry whose `match` fits it (an entry without
 * `match` fits any POST; a GET needs a `match`); a request no entry fits is
 * answered 500 and recorded `unplanned`. A plan entry (`PlanEntry` below) is
 * one response:
 *
 * - an SSE stream: a fixture file under `test/fixtures/sse/` (`sse`) or
 *   inline events (`events`), written one event at a time with `delayMs`
 *   between events; in a fixture file a comment line `: fake-delay <ms>`
 *   before an event is a directive (that event waits `<ms>`; the line is not
 *   sent); every other comment line is sent as it is (providers send them
 *   as keep-alives);
 * - a status with headers and a body (`status`, `headers`, `body`): 401,
 *   429 with `Retry-After`, 5xx, 529 overloaded ...; an error status without
 *   a `body` gets one that carries `BODY_MARKER`, so a test can assert that
 *   no provider body reaches a failure text, log line or record;
 * - `firstByteDelayMs`: nothing at all (not even the status line) is sent
 *   for that long (slow first byte);
 * - `disconnectAfter: n`: the socket is destroyed after `n` events
 *   (mid-stream disconnect; 0 = after the headers);
 * - `hang: true`: no answer at all; the request is recorded `closed` when
 *   the client goes away (cancel, timeout).
 * - `repeat: n`: the entry answers `n` requests (default 1).
 *
 * `requests()` returns, per request in arrival order: `method`, `path`,
 * `json` (the parsed body, or undefined), `bodyBytes`, `authorization`
 * (whether an `authorization` or `x-api-key` header was present), `closed`
 * (the client closed the connection before the response ended),
 * `completed` (the response ended), `unplanned`, `events` (events written).
 *
 * `trace` (option): called with `{ request, event, at }` (`performance.now()`
 * just after each SSE event was handed to the socket); perf uses it for
 * `provider.overhead`.
 *
 * W2.1b (Anthropic fixtures `anthropic-*`) and W2.2 (`*-models.json`) add
 * fixture files and builders; the server itself stays provider-neutral.
 *
 * Node only (tests and perf); not shipped to a vat.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Where the SSE and catalogue fixtures live. */
export const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'sse',
);

/**
 * Text every default error body carries: a test greps failure texts, log
 * lines and state for it and must find nothing.
 */
export const BODY_MARKER = 'FAKE-PROVIDER-BODY-do-not-show';

/**
 * @typedef {string | { data?: unknown, event?: string, comment?: string, delayMs?: number }} PlanEvent
 *   a string is sent as `data: <string>`; `data` that is not a string is
 *   sent as its JSON; `comment` sends `: <comment>`
 */

/**
 * @typedef {object} PlanEntry
 * @property {{ method?: string, path?: string }} [match] default: any POST
 * @property {number} [status] default 200
 * @property {Record<string, string>} [headers]
 * @property {number} [firstByteDelayMs]
 * @property {string} [sse] a fixture file name under `fixturesDir`
 * @property {PlanEvent[]} [events] inline SSE events
 * @property {number} [delayMs] between events (a fixture's `fake-delay`
 *   and an event's `delayMs` take precedence)
 * @property {string | object} [body] a non-SSE body (an object is sent as
 *   JSON)
 * @property {string} [file] a non-SSE body read from a fixture file (JSON)
 * @property {number} [disconnectAfter] destroy the socket after this many
 *   events
 * @property {boolean} [hang]
 * @property {number} [repeat] how many requests this entry answers
 */

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path
 * @property {any} json the parsed body, or undefined
 * @property {number} bodyBytes
 * @property {boolean} authorization a credential header was present
 * @property {boolean} closed the client closed before the response ended
 * @property {boolean} completed
 * @property {boolean} unplanned
 * @property {number} events SSE events written
 * @property {number} receivedAt `performance.now()` when the body was read
 */

/**
 * One SSE event as wire text (a blank line ends it).
 * @param {PlanEvent} event
 */
export const sseEventText = event => {
  if (typeof event === 'string') return `data: ${event}\n\n`;
  /** @type {string[]} */
  const lines = [];
  if (event.comment !== undefined) lines.push(`: ${event.comment}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.data !== undefined) {
    const data =
      typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    for (const line of data.split('\n')) lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
};

/**
 * A whole SSE body (for writing fixture files or large perf streams).
 * @param {PlanEvent[]} events
 */
export const sseText = events => events.map(sseEventText).join('');

/**
 * Split SSE text into wire events. A comment line `: fake-delay <ms>` is a
 * directive for the server, not sent.
 * @param {string} text
 * @returns {{ text: string, delayMs?: number }[]}
 */
export const splitSseFixture = text => {
  /** @type {{ text: string, delayMs?: number }[]} */
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    /** @type {number | undefined} */
    let delayMs;
    const kept = [];
    for (const line of block.split('\n')) {
      const directive = /^: fake-delay (\d+)$/.exec(line);
      if (directive) delayMs = Number(directive[1]);
      else if (line !== '') kept.push(line);
    }
    if (kept.length > 0) {
      out.push({
        text: `${kept.join('\n')}\n\n`,
        ...(delayMs === undefined ? {} : { delayMs }),
      });
    }
  }
  return out;
};

/**
 * OpenRouter chat-completion stream chunks (the OpenAI streaming shape
 * OpenRouter serves: `choices[0].delta.content`, `delta.tool_calls` with an
 * `index` and argument fragments, `finish_reason` on the last choice chunk,
 * then a usage chunk with no choices, then `[DONE]`). Written from the
 * public API shapes that lal `providers/openrouter.js` and
 * `openai-compatible-messages.js` encode.
 *
 * @param {object} [options]
 * @param {string[]} [options.deltas] text pieces, one chunk each
 * @param {Array<{ id?: string, name: string, args: string, pieces?: number }>} [options.toolCalls]
 *   each call's arguments are sent in `pieces` fragments (default 2)
 * @param {string | null} [options.finishReason] default 'stop', or
 *   'tool_calls' when there are calls; null sends none
 * @param {any} [options.usage] the usage chunk's `usage` (null: none)
 * @param {string} [options.model]
 * @param {string} [options.provider]
 * @param {boolean} [options.done] send `[DONE]` (default true)
 * @param {any} [options.error] a mid-stream `error` object in the last chunk
 * @returns {PlanEvent[]}
 */
export const openRouterChunks = ({
  deltas = [],
  toolCalls = [],
  finishReason = toolCalls.length ? 'tool_calls' : 'stop',
  usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  model = 'fake-org/fake-model',
  provider = 'Fake Provider',
  done = true,
  error,
} = {}) => {
  const base = {
    id: 'gen-fake-1',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    provider,
  };
  /** @type {PlanEvent[]} */
  const events = [{ comment: 'OPENROUTER PROCESSING' }];
  /**
   * @param {any} delta
   * @param {string | null} [finish]
   */
  const chunk = (delta, finish = null) => ({
    data: {
      ...base,
      choices: [{ index: 0, delta, finish_reason: finish }],
    },
  });
  events.push(chunk({ role: 'assistant', content: '' }));
  for (const text of deltas) events.push(chunk({ content: text }));
  toolCalls.forEach((call, index) => {
    const pieces = Math.max(1, call.pieces ?? 2);
    const size = Math.ceil(call.args.length / pieces) || 1;
    for (let i = 0; i < pieces; i += 1) {
      const fragment = call.args.slice(i * size, (i + 1) * size);
      /** @type {any} */
      const entry = { index, function: { arguments: fragment } };
      if (i === 0) {
        if (call.id !== undefined) entry.id = call.id;
        entry.type = 'function';
        entry.function.name = call.name;
      }
      events.push(chunk({ tool_calls: [entry] }));
    }
  });
  if (error !== undefined) {
    events.push({
      data: {
        ...base,
        error,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      },
    });
  } else if (finishReason !== null) {
    events.push(chunk({}, finishReason));
  }
  if (usage !== null) events.push({ data: { ...base, choices: [], usage } });
  if (done) events.push('[DONE]');
  return events;
};

/**
 * A fixture's text (`fixturesDir`).
 * @param {string} name a bare file name
 */
export const readFixture = name => {
  if (name.includes('/') || name.includes('\\') || name.startsWith('.'))
    throw Error(`fixture name must be a bare file name: ${name}`);
  return readFileSync(join(fixturesDir, name), 'utf8');
};

/** @type {Record<string, string>} */
const ROUTES = {
  'POST /api/v1/chat/completions': 'openrouter',
  'GET /api/v1/models': 'openrouter',
  'POST /v1/messages': 'anthropic',
  'GET /v1/models': 'anthropic',
};

/**
 * @param {object} [options]
 * @param {string} [options.fixtures] the fixture directory (default
 *   `fixturesDir`)
 * @param {PlanEntry[]} [options.plan]
 * @param {(entry: { request: number, event: number, at: number }) => void} [options.trace]
 */
export const startFakeProviderServer = async ({
  fixtures = fixturesDir,
  plan: initialPlan = [],
  trace,
} = {}) => {
  /** @type {PlanEntry[]} */
  let plan = [...initialPlan];
  /** @type {Map<PlanEntry, number>} answers left per entry */
  const left = new Map();
  /** @type {RecordedRequest[]} */
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
    if (index < 0) return undefined;
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
    const path = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    let json;
    try {
      json = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      json = undefined;
    }
    /** @type {RecordedRequest} */
    const record = {
      method,
      path,
      json,
      bodyBytes: raw.length,
      authorization:
        req.headers.authorization !== undefined ||
        req.headers['x-api-key'] !== undefined,
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
    const entry =
      ROUTES[`${method} ${path}`] === undefined
        ? undefined
        : take(method, path);
    if (entry === undefined) {
      record.unplanned = true;
      res.writeHead(ROUTES[`${method} ${path}`] === undefined ? 404 : 500, {
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
    if (entry.hang) return; // `closed` is set when the client goes.
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
        // Before a planned disconnect every event so far reaches the
        // socket, so the client sees exactly `disconnectAfter` events.
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
    url,
    /** The OpenRouter base URL a backend spec's `baseUrl` takes. */
    openRouterBaseUrl: `${url}/api/v1`,
    /** The Anthropic base URL. */
    anthropicBaseUrl: url,
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
    /** @returns {RecordedRequest[]} */
    requests: () => recorded.map(entry => ({ ...entry })),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  };
};

/** @typedef {Awaited<ReturnType<typeof startFakeProviderServer>>} FakeProviderServer */
