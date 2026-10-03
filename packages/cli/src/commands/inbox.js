/* eslint-disable no-continue */

import os from 'os';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { withEndoAgent } from '../context.js';
import { formatMessage } from '../message-format.js';

const { stringify: q } = JSON;

export const inbox = async ({ follow, agentNames }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    /** @type {string | undefined} */
    let selfLocator;
    /**
     * A guest reads its correspondents by its own pet names (`fromNames`,
     * `toNames`) and holds no locators; a host reads locators and names them
     * by reverse lookup.
     *
     * @param {any} message
     */
    const correspondents = async message => {
      if (message.fromNames !== undefined) {
        const { fromNames, toNames } = message;
        return {
          fromSelf: fromNames.includes('@self'),
          toSelf: toNames.includes('@self'),
          fromName: fromNames[0],
          toName: toNames[0],
        };
      }
      selfLocator ??= await E(agent).locate('@self');
      const { from, to } = message;
      const fromSelf = from === selfLocator;
      const toSelf = to === selfLocator;
      const [fromName] = fromSelf ? [] : await E(agent).reverseLocate(from);
      const [toName] = toSelf ? [] : await E(agent).reverseLocate(to);
      return { fromSelf, toSelf, fromName, toName };
    };
    const messages = follow
      ? iterateReader(E(agent).followMessages())
      : await E(agent).listMessages();
    const messageNumberById = new Map();
    if (!follow) {
      for (const message of messages) {
        messageNumberById.set(message.messageId, message.number);
      }
    }
    for await (const message of messages) {
      messageNumberById.set(message.messageId, message.number);
      const { number, type, date } = message;

      let verb = '';
      if (type === 'request') {
        verb = 'requested';
      } else if (type === 'package') {
        verb = message.replyTo === undefined ? 'sent' : 'replied to';
      } else if (type === 'definition') {
        verb = 'proposed definition';
      } else if (type === 'form') {
        verb = 'sent form';
      } else if (type === 'value') {
        verb = 'sent value';
      } else {
        verb = 'sent an unrecognizable message';
      }

      let provenance = 'unrecognizable message';
      const { fromSelf, toSelf, fromName, toName } =
        await correspondents(message);
      if (fromSelf && toSelf) {
        provenance = `you ${verb} yourself `;
      } else if (fromSelf) {
        if (toName === undefined) {
          continue;
        }
        provenance = `${verb} ${q(toName)} `;
      } else if (toSelf) {
        if (fromName === undefined) {
          continue;
        }
        provenance = `${q(fromName)} ${verb} `;
      } else {
        if (fromName === undefined || toName === undefined) {
          continue;
        }
        provenance = `${q(fromName)} ${verb} ${q(toName)} `;
      }

      if (message.type === 'request') {
        const { description } = message;
        console.log(
          `${number}. ${provenance}${JSON.stringify(
            description,
          )} at ${JSON.stringify(date)}`,
        );
      } else if (message.type === 'package') {
        const { strings, names: edgeNames, replyTo } = message;
        let replyContext = '';
        if (replyTo !== undefined) {
          const replyNumber = messageNumberById.get(replyTo);
          replyContext =
            replyNumber === undefined
              ? ' (in reply to unknown)'
              : ` (in reply to ${replyNumber})`;
        }
        console.log(
          `${number}. ${provenance}${formatMessage(
            strings,
            edgeNames,
          )}${replyContext} at ${JSON.stringify(date)}`,
        );
      } else if (message.type === 'definition') {
        const { source, slots } = message;
        const slotNames = Object.keys(slots || {}).join(', ');
        const slotInfo = slotNames ? ` (slots: ${slotNames})` : '';
        console.log(
          `${number}. ${provenance}${q(source)}${slotInfo} at ${q(date)}`,
        );
      } else if (message.type === 'form') {
        const { description, fields } = message;
        const fieldNames = (fields || []).map(f => f.name).join(', ');
        const fieldInfo = fieldNames ? ` (fields: ${fieldNames})` : '';
        console.log(
          `${number}. ${provenance}${q(description)}${fieldInfo} at ${q(date)}`,
        );
      } else if (message.type === 'value') {
        const { replyTo } = message;
        const replyNumber = messageNumberById.get(replyTo);
        const replyContext =
          replyNumber === undefined ? 'unknown' : `#${replyNumber}`;
        console.log(
          `${number}. ${provenance}in reply to ${replyContext} at ${q(date)}`,
        );
      } else {
        console.log(`${number}. ${provenance}, consider upgrading.`);
      }
    }
  });
