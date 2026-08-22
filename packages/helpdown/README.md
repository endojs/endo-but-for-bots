# `@endo/helpdown`

Helpdown is the small Markdown dialect Endo capabilities use to author the text
their conventional `help(method?)` method returns.
This package holds the scanner that reads it and the factory that serves it.

A helpdown document is ordinary Markdown read structurally:

- A level-1 header opens an entity.
  The entity name is everything before the first ` - ` separator, so
  `# EndoDirectory - A naming hub for pet names.` names `EndoDirectory`.
- A level-2 header opens a method.
  The method name is the identifier before the first `(`, so
  `## has(...petNamePath) -> Promise<boolean>` names `has`.
- Body text belongs to whichever header precedes it.
  The entity overview is stored under the empty-string key.

Headers inside fenced code blocks and blockquotes are content, not structure,
so a document can show helpdown examples without confusing the scanner.

## Entry points

The package is split by lifetime rather than by topic.

`@endo/helpdown` is the runtime entry.
It exports `parseHelpdown` and `makeHelp` and imports no host builtins, so it
loads under XS and in any SES realm exactly as it does under Node.js.

`@endo/helpdown/tools.js` is the build-time entry.
It exports `loadHelpTextFile` and `readHelpTextFileSync`, and it is the only
module in the package that imports `node:fs`.
A capability package that compiles its `help.md` to a checked-in data module
reaches for this entry from its generator script and never from its sources.

## Usage

Parse a document and serve it:

```js
import { parseHelpdown, makeHelp } from '@endo/helpdown';

const entries = parseHelpdown(text);
const helpByEntity = new Map(entries);
const help = makeHelp(helpByEntity.get('EndoDirectory'));

help(); // the entity overview
help('has'); // 'has(...petNamePath) -> Promise<boolean>\n...'
```

`makeHelp` takes an optional array of fallback records, searched in order when
the primary record has no entry for the requested name:

```js
const help = makeHelp(hostHelp, [directoryHelp, mailHelp]);
```

When nothing matches, `help()` returns
`No documentation available for this interface.` and `help(name)` returns
`No documentation available for method "<name>".`.
That wording lives in exactly one place so it cannot drift between the
capabilities that show it.

Read a document from disk, from a build script:

```js
import { readHelpTextFileSync } from '@endo/helpdown/tools.js';

const helpByEntity = readHelpTextFileSync(
  new URL('help.md', import.meta.url),
);
```

`loadHelpTextFile` is the async iterable form of the same read.

## Bugs

See [our issues](https://github.com/endojs/endo/issues).
