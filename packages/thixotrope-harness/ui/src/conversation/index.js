// @ts-check
/**
 * The conversation views (m3-interfaces.md 17, W3.6). The shell renders
 * `Conversation` in its main region, `Composer` under it and `Recovery` in
 * place of the conversation while the recovery panel is open; each receives
 * `{ state, controller, features, context, narrow }`.
 *
 * Nothing in this directory imports `ui/src/shell/` or `ui/src/features.js`
 * (see `slots.js`): the Node feature list imports this module.
 */
export { Composer } from './Composer.js';
export { Conversation } from './Conversation.js';
export { MessageList, TurnView } from './MessageList.js';
export { Queue } from './Queue.js';
export { Recovery } from './Recovery.js';
export { StatusRow } from './StatusRow.js';
