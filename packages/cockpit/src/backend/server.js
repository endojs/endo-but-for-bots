// @ts-check
//
// http + websocket front end on a cockpit. One multiplexed websocket carries
// every thread's events, keyed by thread id (designs/garden-cockpit.md
// § Transport). The message handler is factored out as a pure function so the
// wire protocol is testable without a real socket.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, normalize } from 'node:path';

import { attachWebSocketServer } from './ws.js';
import { buildMockCaps, makeMockCap } from '../index.js';
import { exportTranscript } from './journal.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const MIME = harden({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

const threadsMsg = cockpit => ({
  type: 'threads',
  tree: cockpit.registry.tree(),
});
const templatesMsg = cockpit => ({
  type: 'templates',
  list: cockpit.templates.list(),
});
const o11yMsg = cockpit => ({ type: 'o11y', summary: cockpit.o11y.summary() });
const stewardMsg = cockpit => ({
  type: 'steward',
  view: cockpit.steward.view(),
});
const daemonMsg = cockpit => ({
  type: 'daemon',
  online: cockpit.daemon.online,
  sockPath: cockpit.daemon.sockPath,
});

/**
 * Build a `profiles` message (MASKED views only — never the apiKey).
 *
 * @param {ReturnType<import('../index.js').makeCockpit>} cockpit
 */
const profilesMsg = async cockpit => {
  const list = await cockpit.profiles.list();
  return { type: 'profiles', list };
};

/**
 * Derive the agentry meta from a wire message, or undefined for a mock thread.
 * A thread is agentry only when the daemon is online AND a profileName is given.
 *
 * @param {ReturnType<import('../index.js').makeCockpit>} cockpit
 * @param {Record<string, unknown>} msg
 * @returns {import('./thread.js').AgentryMeta | undefined}
 */
const agentryMetaFrom = (cockpit, msg) => {
  if (!cockpit.daemon.online || typeof msg.profileName !== 'string') {
    return undefined;
  }
  return harden({
    profileName: msg.profileName,
    model: typeof msg.model === 'string' ? msg.model : '',
    workspacePetName:
      typeof msg.workspacePetName === 'string'
        ? msg.workspacePetName
        : undefined,
    gitPetName: typeof msg.gitPetName === 'string' ? msg.gitPetName : undefined,
    gitMode:
      msg.gitMode === 'readOnly' || msg.gitMode === 'readWrite'
        ? msg.gitMode
        : undefined,
  });
};

/**
 * Route one parsed client message. `send` replies to the sender; `broadcast`
 * fans out to every connected client.
 *
 * @param {ReturnType<import('../index.js').makeCockpit>} cockpit
 * @param {(obj: object) => void} send
 * @param {(obj: object) => void} broadcast
 */
export const makeMessageHandler = (cockpit, send, broadcast) => async raw => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({ type: 'error', message: 'invalid json' });
    return;
  }
  // Any state mutation re-pushes both the thread tree and the o11y aggregates.
  const pushState = () => {
    broadcast(threadsMsg(cockpit));
    broadcast(o11yMsg(cockpit));
  };
  await null;
  try {
    switch (msg.type) {
      case 'hello':
        send(threadsMsg(cockpit));
        send(templatesMsg(cockpit));
        send(o11yMsg(cockpit));
        send(stewardMsg(cockpit));
        send(daemonMsg(cockpit));
        send(await profilesMsg(cockpit));
        break;
      case 'steer': {
        const thread = cockpit.registry.get(msg.threadId);
        if (!thread) throw new Error(`unknown thread ${msg.threadId}`);
        await thread.steer(String(msg.text || ''));
        pushState();
        break;
      }
      case 'new-thread': {
        // When the daemon is online and the message names a provider profile,
        // build a real agentry thread; otherwise the mock path (the default).
        const agentry = agentryMetaFrom(cockpit, msg);
        const thread = agentry
          ? await cockpit.registry.createAgentry({
              templateName: msg.templateName || 'adhoc',
              caps: buildMockCaps(msg.caps || []),
              agentry,
            })
          : cockpit.registry.create({
              templateName: msg.templateName || 'adhoc',
              caps: buildMockCaps(msg.caps || []),
            });
        pushState();
        if (msg.prompt) thread.prompt(String(msg.prompt));
        break;
      }
      case 'spawn': {
        // delegateCodeMode: the registry enforces the subset rule and rejects
        // any upgrade, so an invalid delegation surfaces as an error here.
        await cockpit.registry.delegate(msg.parentId, {
          templateName: msg.templateName || 'delegate',
          caps: buildMockCaps(msg.caps || []),
          prompt: msg.prompt ? String(msg.prompt) : undefined,
          agentry: agentryMetaFrom(cockpit, msg),
        });
        pushState();
        break;
      }
      case 'list-profiles':
        send(await profilesMsg(cockpit));
        break;
      case 'define-profile': {
        // Stores the (provider, apiKey, baseUrl) tuple in the daemon petstore.
        // The reply and broadcast carry MASKED views only — never the apiKey.
        await cockpit.profiles.define({
          name: String(msg.name || ''),
          provider: String(msg.provider || ''),
          apiKey: String(msg.apiKey || ''),
          baseUrl: msg.baseUrl ? String(msg.baseUrl) : undefined,
        });
        broadcast(await profilesMsg(cockpit));
        break;
      }
      case 'daemon':
        send(daemonMsg(cockpit));
        break;
      case 'revoke-cap': {
        // The thesis in one gesture: drop a cap and the agent can no longer
        // reach it. Propagates down the delegated lineage.
        cockpit.registry.revokeCap(msg.threadId, msg.capName);
        pushState();
        break;
      }
      case 'grant-cap': {
        const thread = cockpit.registry.get(msg.threadId);
        if (!thread) throw new Error(`unknown thread ${msg.threadId}`);
        cockpit.registry.grantCap(msg.threadId, makeMockCap(msg.cap));
        pushState();
        break;
      }
      case 'list-templates':
        send(templatesMsg(cockpit));
        break;
      case 'define-template':
        cockpit.templates.define(msg.template || {});
        broadcast(templatesMsg(cockpit));
        break;
      case 'delete-template':
        cockpit.templates.remove(msg.name);
        broadcast(templatesMsg(cockpit));
        break;
      case 'o11y':
        send(o11yMsg(cockpit));
        break;
      case 'steward':
        send(stewardMsg(cockpit));
        break;
      case 'export-thread': {
        const thread = cockpit.registry.get(msg.threadId);
        if (!thread) throw new Error(`unknown thread ${msg.threadId}`);
        send({
          type: 'transcript',
          threadId: msg.threadId,
          markdown: exportTranscript(thread),
        });
        break;
      }
      default:
        send({ type: 'error', message: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    send({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
harden(makeMessageHandler);

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string | Uint8Array} body
 * @param {string} type
 */
const respond = (res, code, body, type) => {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
};

const serveStatic = async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = normalize(PUBLIC_DIR + rel.replace(/^\/+/, ''));
  if (!path.startsWith(PUBLIC_DIR)) {
    respond(res, 403, 'forbidden', 'text/plain');
    return;
  }
  await null;
  try {
    const body = await readFile(path);
    respond(res, 200, body, MIME[extname(path)] || 'application/octet-stream');
  } catch {
    respond(res, 404, 'not found', 'text/plain');
  }
};

/**
 * Build the harness-host http server. Caller listens.
 *
 * @param {ReturnType<import('../index.js').makeCockpit>} cockpit
 */
export const makeCockpitServer = cockpit => {
  /** @type {Set<(str: string) => void>} */
  const clients = new Set();
  const broadcast = obj => {
    const str = JSON.stringify(obj);
    for (const client of clients) client(str);
  };
  cockpit.onEvent((threadId, event) =>
    broadcast({ type: 'thread-event', threadId, event }),
  );

  const httpServer = createServer((req, res) => {
    serveStatic(req, res).catch(() => respond(res, 500, 'error', 'text/plain'));
  });

  /** @type {Set<{ destroy: () => void }>} */
  const conns = new Set();
  attachWebSocketServer(httpServer, {
    path: '/ws',
    onConnection: conn => {
      const raw = str => conn.send(str);
      clients.add(raw);
      conns.add(conn);
      const send = obj => conn.send(JSON.stringify(obj));
      const handler = makeMessageHandler(cockpit, send, broadcast);
      conn.onMessage(handler);
      conn.onClose(() => {
        clients.delete(raw);
        conns.delete(conn);
      });
      send(threadsMsg(cockpit));
    },
  });

  // Graceful shutdown: upgraded sockets are detached from the http server's
  // connection tracking, so close() alone would hang. Destroy them first.
  // @ts-expect-error augmenting the http server with a shutdown helper
  httpServer.shutdown = () => {
    for (const conn of conns) conn.destroy();
    return new Promise(resolve => httpServer.close(() => resolve(undefined)));
  };

  return httpServer;
};
harden(makeCockpitServer);
