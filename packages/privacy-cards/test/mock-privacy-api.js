// @ts-check

// Minimal in-memory stand-in for the Privacy.com v1 API, faithful to
// the request/response shapes the caplet relies on. Shared by the
// package unit tests and the daemon integration test.

import http from 'node:http';

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 */
export const makeMockPrivacyApi = async ({ apiKey }) => {
  /** @type {Map<string, any>} */
  const cards = new Map();
  /** @type {Map<string, any[]>} */
  const transactions = new Map();
  let nextCard = 1;
  let failNextCreate = false;

  /**
   * @param {object} spec Privacy card-creation body shape.
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
      memo: /** @type {any} */ (spec).memo || '',
      spend_limit: /** @type {any} */ (spec).spend_limit,
      spend_limit_duration: /** @type {any} */ (spec).spend_limit_duration,
      state: /** @type {any} */ (spec).state || 'OPEN',
      type: /** @type {any} */ (spec).type,
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
      response.writeHead(status, { 'Content-Type': 'application/json' });
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
        Object.assign(card, JSON.parse(requestBody));
        reply(200, card);
      } else if (request.method === 'GET' && pathname === '/v1/transactions') {
        const token = url.searchParams.get('card_token');
        reply(200, {
          data: transactions.get(token || '') || [],
          page: 1,
          total_pages: 1,
        });
      } else {
        reply(404, { message: 'no such endpoint' });
      }
    });
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = /** @type {import('net').AddressInfo} */ (server.address());

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
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve(undefined));
      }),
  });
};
harden(makeMockPrivacyApi);
