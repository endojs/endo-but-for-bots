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
import { buildMockCaps } from '../index.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const threadsMsg = cockpit => ({ type: 'threads', tree: cockpit.registry.tree() });

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
  try {
    switch (msg.type) {
      case 'hello':
        send(threadsMsg(cockpit));
        break;
      case 'steer': {
        const thread = cockpit.registry.get(msg.threadId);
        if (!thread) throw new Error(`unknown thread ${msg.threadId}`);
        await thread.steer(String(msg.text || ''));
        broadcast(threadsMsg(cockpit));
        break;
      }
      case 'new-thread': {
        const thread = cockpit.registry.create({
          templateName: msg.templateName || 'adhoc',
          caps: buildMockCaps(msg.caps || []),
        });
        broadcast(threadsMsg(cockpit));
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
        });
        broadcast(threadsMsg(cockpit));
        break;
      }
      default:
        send({ type: 'error', message: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

/** @param {import('node:http').ServerResponse} res @param {number} code @param {string} body @param {string} type */
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
