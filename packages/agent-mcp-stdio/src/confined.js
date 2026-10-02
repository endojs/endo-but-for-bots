// @ts-check
/// <reference types="ses"/>

// The confined allow-list the guest broker serves
// (designs/endo-guest-stdio-mcp.md § How the confinement properties change,
// shape 1). The README documents the served and withheld names and how a
// withheld name is refused.
//
// The withheld identifier and formula-locator tools are the ones that take or
// mint a designation (endo-but-for-bots#1371, #1404). Served results are not
// scrubbed: `listMessages`, `followMessages`, and `followNameChanges` still
// disclose locators and identifiers, which grant nothing without the withheld
// tools. Content locators carry no designation authority, but `loadContent` is
// withheld too: it makes the daemon fetch over HTTP(S) from any `ws=` source
// hint in a caller-supplied magnet locator, and the content plane has no
// destination allowlist, so serving it would grant the confined side outbound
// network authority from the daemon process.
//
// `@endo/claude`'s `CODE_EVAL_NAMES` deny-list is a separate belt; the two
// lists are not kept in sync, and this allow-list is the boundary.

/** The tool names the confined broker serves. */
export const confinedToolNames = harden([
  // Names.
  'help',
  'has',
  'list',
  'remove',
  'move',
  'copy',
  // Content locators.
  'locateContent',
  'listContent',
  'storeContent',
  'reverseLocateContent',
  'internalizeContentLocator',
  // Files and search.
  'makeDirectory',
  'makePath',
  'readText',
  'maybeReadText',
  'writeText',
  'storeValue',
  'glob',
  'grep',
  'glorp',
  // Mail.
  'listMessages',
  'send',
  'reply',
  'editMessage',
  'messageHistory',
  'adopt',
  'dismiss',
  'dismissAll',
  'request',
  'resolve',
  'reject',
  'sendValue',
  'form',
  'submit',
  // Following.
  'followMessages',
  'followNameChanges',
  'followStream',
  'readFollower',
  'closeFollower',
]);

/**
 * Keep only the declarations an allow-list names, in declaration order. A name
 * the allow-list holds but the declaration lacks is ignored.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} tools
 * @param {ReadonlyArray<string>} [allowedNames]
 * @returns {ReadonlyArray<T>}
 */
export const selectConfinedTools = (
  tools,
  allowedNames = confinedToolNames,
) => {
  const allowed = new Set(allowedNames);
  return harden(tools.filter(({ name }) => allowed.has(name)));
};
harden(selectConfinedTools);
