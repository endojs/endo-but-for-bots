// @ts-check
// Opt-in measurement loader; production modules on disk are left untouched.
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

const key = Symbol.for('thixotrope.mailProfile');
const clock = () => performance.timeOrigin + performance.now();
const trace = {
  enabled: false,
  started: false,
  events: [],
  trials: [],
  clock,
  span(kind, name, start, end, extra = {}) {
    if (trace.enabled || (kind === 'worker-request' && trace.started)) {
      trace.events.push({ kind, name, start, end, ...extra });
    }
  },
  time(name, fn) {
    const start = clock();
    try {
      return fn();
    } finally {
      trace.span('host', name, start, clock());
    }
  },
  async async(name, fn) {
    const start = clock();
    try {
      return await fn();
    } finally {
      trace.span('stage', name, start, clock());
    }
  },
  begin(trial) {
    trace.started = true;
    trace.enabled = true;
    const window = { trial, start: clock() };
    trace.trials.push(window);
    return window;
  },
  end(window) {
    window.end = clock();
    trace.enabled = false;
  },
  native(event, worker) {
    if (trace.started)
      trace.events.push({
        kind: 'vm',
        name: event.phase,
        request: event.request,
        start: event.start,
        end: event.start + event.ms,
        pid: event.pid,
        worker,
      });
  },
};
globalThis[key] = trace;
const profile = 'globalThis[Symbol.for("thixotrope.mailProfile")]';
const replace = (source, from, to) => {
  if (!source.includes(from))
    throw Error(`Profiling hook no longer matches: ${from}`);
  return source.replace(from, to);
};
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url.endsWith('/packages/ocapn/src/client/ocapn.js')) {
      const source = result.source?.toString();
      if (source === undefined) return result;
      return {
        ...result,
        source: replace(
          source,
          'const gcBatching = true;',
          `const gcBatching = ${process.env.THIX_MAIL_GC !== 'off'};`,
        ),
      };
    }
    if (!url.includes('/packages/thixotrope/src/')) return result;
    let source = result.source?.toString();
    if (source === undefined) return result;
    if (url.endsWith('/core/daemon.js')) {
      if (
        process.env.THIX_MAIL_TRANSFERS === 'off' ||
        process.env.THIX_MAIL_TRANSFERS === 'cleanup'
      ) {
        source = replace(
          source,
          'onFrames: frames => holder.sink.deliverBatch(frames),',
          'onFrames: undefined,',
        );
      }
      if (
        process.env.THIX_MAIL_TRANSFERS === 'off' ||
        process.env.THIX_MAIL_TRANSFERS === 'batch'
      ) {
        source = replace(source, 'deferCleanup: true,', 'deferCleanup: false,');
      }
    } else if (url.endsWith('/net/hub.js')) {
      source = replace(
        source,
        'const gcBatching = true;',
        `const gcBatching = ${!['off', 'client'].includes(process.env.THIX_MAIL_GC)};`,
      );
    } else if (url.endsWith('/net/hub-state.js')) {
      source = replace(
        source,
        '  /** @type {any} */\n  const state = {',
        `  const profileStart = ${profile}.clock();\n  /** @type {any} */\n  const state = {`,
      );
      source = replace(
        source,
        '  return state;',
        `  ${profile}.span('host', 'hub.table-serialization', profileStart, ${profile}.clock());\n  return state;`,
      );
    } else if (url.endsWith('/store/store-fs.js')) {
      source = replace(
        source,
        'JSON.stringify(state)',
        `${profile}.time('hub.json-serialization', () => JSON.stringify(state))`,
      );
    } else if (url.endsWith('/web/mail-ui-service.js')) {
      source = replace(
        source,
        '  const project = state => {',
        `  const project = state => {\n    const profileStart = ${profile}.clock();`,
      );
      source = replace(
        source,
        '    offered = currentOffers;\n    return result;',
        `    offered = currentOffers;\n    ${profile}.span('host', 'ui.projection', profileStart, ${profile}.clock());\n    return result;`,
      );
      source = replace(
        source,
        'await E(contacts).get(recipient)',
        `await ${profile}.async('contact-lookup', () => E(contacts).get(recipient))`,
      );
      source = replace(
        source,
        'return E(book).send(contact, harden(content));',
        `return ${profile}.async('send-and-notify', () => E(book).send(contact, harden(content)));`,
      );
    } else return result;
    return { ...result, source };
  },
});
