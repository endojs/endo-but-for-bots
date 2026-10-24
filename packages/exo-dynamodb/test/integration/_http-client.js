// @ts-check

/**
 * A minimal DynamoDB JSON-protocol client for DynamoDB Local. DynamoDB Local
 * parses but does not verify request signatures, so this adapter sends a
 * fixed placeholder authorization header. It is test infrastructure only:
 * real AWS calls belong to the host's SDK client.
 */

import { decodeBase64, encodeBase64 } from '@endo/base64';

const targets = harden({
  getItem: 'GetItem',
  putItem: 'PutItem',
  updateItem: 'UpdateItem',
  deleteItem: 'DeleteItem',
  query: 'Query',
  transactGetItems: 'TransactGetItems',
  transactWriteItems: 'TransactWriteItems',
  createTable: 'CreateTable',
  deleteTable: 'DeleteTable',
});

/** @param {unknown} value */
const decodeBinary = value => {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, element]) => {
        if (name === 'B' && typeof element === 'string') {
          return [name, decodeBase64(element)];
        }
        if (name === 'BS' && Array.isArray(element)) {
          return [name, element.map(entry => decodeBase64(entry))];
        }
        return [name, decodeBinary(element)];
      }),
    );
  }
  return value;
};

/**
 * @param {string} endpoint
 * @param {typeof fetch} fetchPower
 */
export const makeHttpDynamoClient = (endpoint, fetchPower) => {
  /**
   * @param {string} operation
   * @param {unknown} input
   */
  const call = async (operation, input) => {
    const response = await fetchPower(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': `DynamoDB_20120810.${targets[operation]}`,
        authorization:
          'AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=00',
      },
      body: JSON.stringify(input, (_name, value) =>
        value instanceof Uint8Array ? encodeBase64(value) : value,
      ),
    });
    const body = decodeBinary(await response.json());
    if (!response.ok) {
      // eslint-disable-next-line no-underscore-dangle
      const type = String(body.__type ?? 'UnknownError')
        .split('#')
        .at(-1);
      throw Object.assign(new Error(body.message ?? body.Message ?? type), {
        name: type,
        CancellationReasons: body.CancellationReasons,
      });
    }
    return body;
  };
  return harden({
    /** @param {{ operation: string, input: unknown }} request */
    send: ({ operation, input }) => call(operation, input),
    /** Host-side table control, never exposed through a capability. */
    control: call,
  });
};
harden(makeHttpDynamoClient);
