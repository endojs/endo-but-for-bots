// @ts-check

/** @import { DynamoValue, Item } from '../types.js' */

import { decodeBase64, encodeBase64 } from '@endo/base64';
import { Fail, q } from '@endo/errors';
import { passStyleOf } from '@endo/pass-style';
import { getCopySetKeys, isCopySet, makeCopySet } from '@endo/patterns';

/**
 * Marshal a passable value to the JSON form of a DynamoDB AttributeValue.
 * Binary values remain Uint8Arrays when `binary: 'bytes'` and become base64
 * strings by default, which is convenient for wire-neutral test adapters.
 *
 * @param {DynamoValue} value
 * @param {{ binary?: 'base64' | 'bytes' }} [options]
 * @returns {Record<string, any>}
 */
export const marshalValue = (value, options = {}) => {
  if (value === null) return harden({ NULL: true });
  if (typeof value === 'string') return harden({ S: value });
  if (typeof value === 'boolean') return harden({ BOOL: value });
  if (typeof value === 'number') {
    Number.isFinite(value) || Fail`DynamoDB numbers must be finite`;
    return harden({ N: `${value}` });
  }
  if (typeof value === 'bigint') return harden({ N: `${value}` });
  if (value instanceof Uint8Array) {
    return harden({
      B: options.binary === 'bytes' ? value : encodeBase64(value),
    });
  }
  if (Array.isArray(value)) {
    return harden({ L: value.map(element => marshalValue(element, options)) });
  }
  const style = passStyleOf(/** @type {any} */ (value));
  style !== 'remotable' || Fail`DynamoDB items cannot contain remotables`;
  if (style === 'copyRecord') {
    return harden({
      M: Object.fromEntries(
        Object.entries(value).map(([name, element]) => [
          name,
          marshalValue(element, options),
        ]),
      ),
    });
  }
  if (isCopySet(value)) {
    const values = getCopySetKeys(/** @type {any} */ (value));
    values.length > 0 || Fail`DynamoDB sets cannot be empty`;
    if (values.every(element => typeof element === 'string')) {
      return harden({ SS: values });
    }
    if (
      values.every(
        element => typeof element === 'number' || typeof element === 'bigint',
      )
    ) {
      return harden({ NS: values.map(element => `${element}`) });
    }
    if (values.every(element => element instanceof Uint8Array)) {
      return harden({
        BS: values.map(element =>
          options.binary === 'bytes' ? element : encodeBase64(element),
        ),
      });
    }
    Fail`DynamoDB sets must contain values of one scalar type`;
  }
  return Fail`Unsupported DynamoDB value pass style ${q(style)}`;
};
harden(marshalValue);

/**
 * @param {Item} item
 * @param {{ binary?: 'base64' | 'bytes' }} [options]
 */
export const marshalItem = (item, options = {}) =>
  harden(
    Object.fromEntries(
      Object.entries(item).map(([name, value]) => [
        name,
        marshalValue(value, options),
      ]),
    ),
  );
harden(marshalItem);

/**
 * @param {Record<string, any>} attribute
 * @param {{ binary?: 'base64' | 'bytes' }} [options]
 * @returns {DynamoValue}
 */
export const unmarshalValue = (attribute, options = {}) => {
  if ('S' in attribute) return attribute.S;
  if ('N' in attribute) {
    const text = attribute.N;
    if (/^-?(?:0|[1-9]\d*)$/.test(text)) {
      const integer = BigInt(text);
      const number = Number(integer);
      return Number.isSafeInteger(number) ? number : integer;
    }
    return Number(text);
  }
  if ('BOOL' in attribute) return attribute.BOOL;
  if ('NULL' in attribute) return null;
  if ('B' in attribute) {
    return options.binary === 'bytes' || attribute.B instanceof Uint8Array
      ? attribute.B
      : decodeBase64(attribute.B);
  }
  if ('L' in attribute) {
    return harden(attribute.L.map(value => unmarshalValue(value, options)));
  }
  if ('M' in attribute) return unmarshalItem(attribute.M, options);
  if ('SS' in attribute) return makeCopySet(attribute.SS);
  if ('NS' in attribute) {
    return makeCopySet(
      attribute.NS.map(text => {
        if (!/^-?(?:0|[1-9]\d*)$/.test(text)) return Number(text);
        const integer = BigInt(text);
        const number = Number(integer);
        return Number.isSafeInteger(number) ? number : integer;
      }),
    );
  }
  if ('BS' in attribute) {
    return makeCopySet(
      attribute.BS.map(value =>
        options.binary === 'bytes' || value instanceof Uint8Array
          ? value
          : decodeBase64(value),
      ),
    );
  }
  return Fail`Invalid DynamoDB AttributeValue`;
};
harden(unmarshalValue);

/**
 * @param {Record<string, Record<string, any>>} item
 * @param {{ binary?: 'base64' | 'bytes' }} [options]
 * @returns {Item}
 */
export const unmarshalItem = (item, options = {}) =>
  harden(
    Object.fromEntries(
      Object.entries(item).map(([name, value]) => [
        name,
        unmarshalValue(value, options),
      ]),
    ),
  );
harden(unmarshalItem);
