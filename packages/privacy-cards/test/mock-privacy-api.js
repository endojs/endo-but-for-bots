// @ts-check

// Minimal in-memory stand-in for the Privacy.com v1 API, faithful to
// the request/response shapes the caplet relies on. Shared by the
// package unit tests and the daemon integration test.

import http from 'node:http';

/** @import { AddressInfo } from 'node:net' */

/**
 * @typedef {object} MockCardSpec
 * @property {string} [memo]
 * @property {number} [spend_limit]
 * @property {string} [spend_limit_duration]
 * @property {string} [state]
 * @property {string} [type]
 */

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 */
export const makeMockPrivacyApi = async ({ apiKey }) => {
  /** @type {Map<string, any>} */
  const cards = new Map();
  /** @type {Map<string, any[]>} */
  const transactions = new Map();
  // Small pages force the client's pagination walk to actually walk.
  const TRANSACTIONS_PAGE_SIZE = 2;
  let nextCard = 1;
  let failNextCreate = false;
  let transactionsFailing = false;
  /** @type {Set<string>} */
  const failingPatchTokens = new Set();

  /**
   * @param {MockCardSpec} spec Privacy card-creation body shape.
   */
  const recordCard = spec => {
    const token = `card-${nextCard}`;
    nextCard += 1;
    const card = {
      token,
      pan: `411111128914${String(4000 + nextCard)}`,
      cvv: '776',
      exp_month: '06',
      exp_year: '2030',
      last_four: String(4000 + nextCard),
      memo: spec.memo || '',
      spend_limit: spec.spend_limit,
      spend_limit_duration: spec.spend_limit_duration,
      state: spec.state || 'OPEN',
      type: spec.type,
    };
    cards.set(token, card);
    return card;
  };

  const server = http.createServer((request, response) => {
    /**
     * @param {number} status
     * @param {unknown} body
     */
    const reply = (status, body) => {
      // No keep-alive: on Node 24, sockets still pooled by undici's
      // global agent when the server closes at test teardown reject
      // internally with a shared ClientDestroyedError that SES's
      // unhandled-rejection logging hardens, and undici's subsequent
      // attempt to rewrite its message cascades into a TypeError
      // unhandled rejection per pooled request. Closing each
      // connection after its response leaves nothing pooled.
      response.writeHead(status, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      response.end(JSON.stringify(body));
    };
    let requestBody = '';
    request.on('data', chunk => {
      requestBody += chunk;
    });
    request.on('end', () => {
      if (request.headers.authorization !== `api-key ${apiKey}`) {
        reply(401, { message: 'User has not been authenticated' });
        return;
      }
      const url = new URL(
        /** @type {string} */ (request.url),
        'http://localhost',
      );
      const { pathname } = url;
      if (request.method === 'GET' && pathname === '/v1/status') {
        reply(200, { message: 'API is up' });
      } else if (
        request.method === 'GET' &&
        pathname === '/v1/funding-sources'
      ) {
        reply(200, []);
      } else if (request.method === 'GET' && pathname === '/v1/cards') {
        reply(200, { data: [...cards.values()] });
      } else if (request.method === 'POST' && pathname === '/v1/cards') {
        if (failNextCreate) {
          failNextCreate = false;
          reply(500, { message: `internal error; key was ${apiKey}` });
          return;
        }
        reply(200, recordCard(JSON.parse(requestBody)));
      } else if (
        request.method === 'PATCH' &&
        pathname.startsWith('/v1/cards/')
      ) {
        const token = decodeURIComponent(pathname.slice('/v1/cards/'.length));
        const card = cards.get(token);
        if (!card) {
          reply(404, { message: 'card not found' });
          return;
        }
        if (failingPatchTokens.has(token)) {
          reply(500, { message: 'card update failed' });
          return;
        }
        Object.assign(card, JSON.parse(requestBody));
        reply(200, card);
      } else if (request.method === 'GET' && pathname === '/v1/transactions') {
        if (transactionsFailing) {
          reply(500, { message: 'transactions unavailable' });
          return;
        }
        const token = url.searchParams.get('card_token');
        const page = Number(url.searchParams.get('page')) || 1;
        const all = transactions.get(token || '') || [];
        const totalPages = Math.max(
          1,
          Math.ceil(all.length / TRANSACTIONS_PAGE_SIZE),
        );
        reply(200, {
          data: all.slice(
            (page - 1) * TRANSACTIONS_PAGE_SIZE,
            page * TRANSACTIONS_PAGE_SIZE,
          ),
          page,
          total_pages: totalPages,
        });
      } else {
        reply(404, { message: 'no such endpoint' });
      }
    });
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = /** @type {AddressInfo} */ (server.address());

  return harden({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    cards,
    /**
     * Creates a card server-side without going through the caplet — a
     * stand-in for a card whose creation succeeded just before the
     * daemon crashed, leaving the ledger unaware of it.
     *
     * @param {object} spec
     */
    seedCard: spec => recordCard(spec),
    /**
     * @param {string} cardToken
     * @param {{ amount: number, result: string, status: string }} transaction
     */
    addTransaction: (cardToken, transaction) => {
      const list = transactions.get(cardToken) || [];
      list.push(transaction);
      transactions.set(cardToken, list);
    },
    failNextCreate: () => {
      failNextCreate = true;
    },
    /**
     * Makes PATCHes to one card fail until cleared, for exercising
     * partial-failure paths like revoke's failedCardTokens.
     *
     * @param {string} cardToken
     * @param {boolean} [failing]
     */
    setPatchFailing: (cardToken, failing = true) => {
      if (failing) {
        failingPatchTokens.add(cardToken);
      } else {
        failingPatchTokens.delete(cardToken);
      }
    },
    /**
     * Makes GET /transactions fail until cleared, for exercising the
     * spend monitor's lastError path.
     *
     * @param {boolean} failing
     */
    setTransactionsFailing: failing => {
      transactionsFailing = failing;
    },
    close: () =>
      new Promise(resolve => {
        // Belt and braces with Connection: close above — sever any
        // socket a client is still holding so close() cannot hang and
        // no pooled connection outlives the test.
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  });
};
harden(makeMockPrivacyApi);
