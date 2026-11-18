// @ts-check
/**
 * M5's mention features (W5.8; `designs/m5-interfaces.md` 4.1 items 2-3,
 * 10): the composer addon (`mentions.addon`, with `send`) and the
 * transcript's attachment chips (`mentions.chips`). One instance per page.
 */
import { makeMentions } from './mentions.js';

/** @import { UiFeature } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** @type {UiFeature[]} */
export const feature = makeMentions().features;
